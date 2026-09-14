// Phase 1 hardware probe: drive B200-only libuhd over libusb's WebUSB backend
// from inside a browser tab.
//
// Everything that touches USB runs on a spawned pthread, never on the browser
// main thread: libusb's Emscripten backend only needs Asyncify on its
// main-thread path, and proxies to the main thread from a worker instead. That
// is also the arrangement a real GNU Radio block would use, where work() runs
// on the block's own scheduler thread.
#include <libusb-1.0/libusb.h>
#include <uhd/utils/log.hpp>
#include <uhd/utils/log_add.hpp>
#include <uhd/device.hpp>
#include <uhd/usrp/multi_usrp.hpp>
#include <uhd/types/device_addr.hpp>
#include <uhd/stream.hpp>
#include <uhd/version.hpp>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

static std::atomic<int> g_ticks{0};   // proves the main thread kept running

extern "C" {

// Called from JS on the main thread, repeatedly, to show responsiveness.
EMSCRIPTEN_KEEPALIVE int probe_tick() { return ++g_ticks; }

EMSCRIPTEN_KEEPALIVE const char* probe_uhd_version() {
    static std::string v = uhd::get_version_string();
    return v.c_str();
}
}

static void say(const std::string& s) { emscripten_out(s.c_str()); }

static void report(const char* tag, const std::string& msg) {
    // Hand each line to the page so the harness can assert on it.
    MAIN_THREAD_EM_ASM({
        globalThis.__probeLine(UTF8ToString($0), UTF8ToString($1));
    }, tag, msg.c_str());
}

static double now_s() {
    using namespace std::chrono;
    return duration<double>(steady_clock::now().time_since_epoch()).count();
}


// Raw libusb view, below UHD. UHD's find() reports only a verdict; when it says
// "no devices" the interesting question is whether libusb saw the device at
// all, whether open() succeeded, and which of the four vendor interfaces could
// be claimed.
static void libusb_diagnostics() {
    libusb_context* ctx = nullptr;
    int rc = libusb_init(&ctx);
    if (rc != 0) {
        report("libusb", std::string("libusb_init failed: ") + libusb_error_name(rc));
        return;
    }
    report("libusb", "libusb_init OK");

    libusb_device** list = nullptr;
    ssize_t n = libusb_get_device_list(ctx, &list);
    char b[256];
    snprintf(b, sizeof b, "libusb_get_device_list: %zd device(s)", n);
    report("libusb", b);
    if (n <= 0) { libusb_exit(ctx); return; }

    for (ssize_t i = 0; i < n; ++i) {
        libusb_device_descriptor d{};
        if (libusb_get_device_descriptor(list[i], &d) != 0) continue;
        snprintf(b, sizeof b, "device %zd: %04x:%04x (interfaces reported via config)",
                 i, d.idVendor, d.idProduct);
        report("libusb", b);

        libusb_config_descriptor* cfg = nullptr;
        if (libusb_get_active_config_descriptor(list[i], &cfg) == 0 && cfg) {
            snprintf(b, sizeof b, "  bNumInterfaces=%d", cfg->bNumInterfaces);
            report("libusb", b);
            libusb_free_config_descriptor(cfg);
        } else {
            report("libusb", "  could not read active config descriptor");
        }

        libusb_device_handle* h = nullptr;
        double t0 = now_s();
        rc = libusb_open(list[i], &h);
        snprintf(b, sizeof b, "  libusb_open: %s (%.2fs)",
                 rc == 0 ? "OK" : libusb_error_name(rc), now_s() - t0);
        report("libusb", b);
        if (rc != 0) continue;

        for (int iface = 0; iface < 4; ++iface) {
            t0 = now_s();
            int cr = libusb_claim_interface(h, iface);
            snprintf(b, sizeof b, "  claim_interface(%d): %s (%.2fs)",
                     iface, cr == 0 ? "OK" : libusb_error_name(cr), now_s() - t0);
            report("libusb", b);
            if (cr == 0) libusb_release_interface(h, iface);
        }
        libusb_close(h);
    }
    libusb_free_device_list(list, 1);
    libusb_exit(ctx);
}

static void* probe_thread(void*) {
    report("stage", "worker thread started");
    report("gate10", "PASS: UHD/libusb code is running on a pthread");

    libusb_diagnostics();

    // --- Gate 1: enumeration ------------------------------------------------
    uhd::device_addrs_t found;
    try {
        double t0 = now_s();
        found = uhd::device::find(uhd::device_addr_t(""));
        char b[160];
        snprintf(b, sizeof b, "device::find() returned %zu device(s) in %.2fs",
                 found.size(), now_s() - t0);
        report("stage", b);
    } catch (const std::exception& e) {
        report("gate1", std::string("FAIL: device::find() threw: ") + e.what());
        report("done", "1");
        return nullptr;
    }
    if (found.empty()) {
        report("gate1", "FAIL: no B2xx enumerated (is the device granted to this origin?)");
        report("done", "1");
        return nullptr;
    }
    for (auto& a : found) report("found", a.to_string());
    report("gate1", "PASS: WebUSB enumerated a B2xx");

    // --- Gates 2/4/5: firmware, EEPROM identity, FPGA image, compat checks ---
    uhd::usrp::multi_usrp::sptr usrp;
    try {
        double t0 = now_s();
        report("stage", "multi_usrp::make() - loads FPGA image, may take a while");
        usrp = uhd::usrp::multi_usrp::make(found[0]);
        char b[160];
        snprintf(b, sizeof b, "multi_usrp::make() completed in %.2fs", now_s() - t0);
        report("stage", b);
    } catch (const std::exception& e) {
        report("gate45", std::string("FAIL: multi_usrp::make() threw: ") + e.what());
        report("done", "1");
        return nullptr;
    }
    report("gate45", "PASS: EEPROM identity + FPGA image + compat checks completed");
    try {
        report("mboard", usrp->get_mboard_name());
        report("pp", usrp->get_pp_string());
        char b[128];
        snprintf(b, sizeof b, "rx channels: %zu", usrp->get_rx_num_channels());
        report("info", b);
    } catch (const std::exception& e) {
        report("info", std::string("(introspection threw: ") + e.what() + ")");
    }

    // --- Gate 6: rate ladder, single channel, then dual ---------------------
    // Each pass sets the rate, builds a fresh streamer, streams for a fixed
    // wall-clock window and reports what actually arrived. Overflows are
    // expected as the rate climbs; they are the measurement, not a failure.
    auto stream_once = [&](double rate,
                           const std::vector<size_t>& chans,
                           double seconds) -> bool {
        char b[256];
        const size_t nch = chans.size();
        try {
            // Pin the master clock rate to the requested rate where the B2xx can
            // do it (roughly 5 - 61.44 MHz, halved in 2R2T). Without this UHD
            // cannot derive a tick rate for 30.72/56 and coerces the rate UP to
            // 40 MS/s, which then overflows and measures nothing useful.
            if (rate >= 5e6 && rate <= 61.44e6) {
                try {
                    usrp->set_master_clock_rate(rate);
                    snprintf(b, sizeof b, "  master clock rate -> %.3f MHz",
                             usrp->get_master_clock_rate() / 1e6);
                    report("rate", b);
                } catch (const std::exception& e) {
                    snprintf(b, sizeof b, "  set_master_clock_rate(%.2f) threw: %s",
                             rate / 1e6, e.what());
                    report("rate", b);
                }
            }
            usrp->set_rx_rate(rate);
            for (size_t c : chans) {
                usrp->set_rx_freq(uhd::tune_request_t(100e6), c);
                usrp->set_rx_gain(30, c);
            }
            const double actual = usrp->get_rx_rate();

            uhd::stream_args_t sa("fc32", "sc16");
            sa.channels = chans;
            auto rx = usrp->get_rx_stream(sa);

            const size_t spb = rx->get_max_num_samps();
            std::vector<std::vector<std::complex<float>>> mem(
                nch, std::vector<std::complex<float>>(spb));
            std::vector<void*> ptrs;
            for (auto& v : mem) ptrs.push_back(v.data());

            uhd::rx_metadata_t md;
            uhd::stream_cmd_t start(uhd::stream_cmd_t::STREAM_MODE_START_CONTINUOUS);
            if (nch > 1) {
                // Multi-channel: must be a timed start so the channels align.
                usrp->set_time_now(uhd::time_spec_t(0.0));
                start.stream_now = false;
                start.time_spec  = usrp->get_time_now() + uhd::time_spec_t(0.1);
            } else {
                start.stream_now = true;
            }
            rx->issue_stream_cmd(start);

            size_t total = 0, overflows = 0, timeouts = 0, calls = 0, errs = 0;
            const double t0 = now_s();
            while (now_s() - t0 < seconds) {
                size_t n = rx->recv(ptrs, spb, md, 1.0);
                ++calls;
                if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_TIMEOUT) { ++timeouts; continue; }
                if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_OVERFLOW) { ++overflows; continue; }
                if (md.error_code != uhd::rx_metadata_t::ERROR_CODE_NONE) { ++errs; continue; }
                total += n;
            }
            const double el = now_s() - t0;
            rx->issue_stream_cmd(uhd::stream_cmd_t::STREAM_MODE_STOP_CONTINUOUS);

            const double got = total / el / 1e6;           // MS/s per channel
            const double want = actual / 1e6;
            snprintf(b, sizeof b,
                "%zuch req %.2f MS/s -> coerced %.2f | got %.3f MS/s/ch (%.0f%%) "
                "| calls %zu ovf %zu timeouts %zu errs %zu",
                nch, rate / 1e6, want, got, want > 0 ? 100.0 * got / want : 0.0,
                calls, overflows, timeouts, errs);
            report("rate", b);
            return total > 0;
        } catch (const std::exception& e) {
            snprintf(b, sizeof b, "%zuch %.2f MS/s THREW: %s", nch, rate / 1e6, e.what());
            report("rate", b);
            return false;
        }
    };

    const std::vector<size_t> ch0{0};
    bool any = false;
    report("stage", "--- single channel rate ladder ---");
    for (double r : {1e6, 10e6, 15.36e6, 20e6, 30.72e6, 40e6, 56e6})
        any |= stream_once(r, ch0, 3.0);
    report("gate6", any ? "PASS: continuous RX delivered samples"
                        : "FAIL: no samples at any rate");

    // Gate 7: stop/restart at a modest rate, after everything above.
    report("stage", "--- stop/restart ---");
    bool restarted = stream_once(1e6, ch0, 1.5);
    report("gate7", restarted ? "PASS: stop/restart reclaimed the stream"
                              : "FAIL: restart produced no samples");

    // Dual channel, B210 only. 2R2T halves the achievable rate ceiling.
    if (usrp->get_rx_num_channels() >= 2) {
        report("stage", "--- dual channel (informational; out of scope for v1) ---");
        const std::vector<size_t> ch01{0, 1};
        bool dual = false;
        for (double r : {15.36e6})
            dual |= stream_once(r, ch01, 3.0);
        report("gate_dual", dual ? "PASS: dual-channel RX delivered samples"
                                 : "FAIL: no dual-channel samples");
    } else {
        report("gate_dual", "SKIP: 1R1T board, only one RX channel");
    }

    // --- Gate 8: unplug during streaming ------------------------------------
    // The one gate the cancellation patch exists for. A cancelled or failed
    // transfer must produce a bounded error rather than blocking forever.
    {
        char b[256];
        try {
            usrp->set_master_clock_rate(10e6);
            usrp->set_rx_rate(1e6);
            usrp->set_rx_freq(uhd::tune_request_t(100e6), 0);
            uhd::stream_args_t sa("fc32", "sc16");
            sa.channels = {0};
            auto rx = usrp->get_rx_stream(sa);
            std::vector<std::complex<float>> buf(rx->get_max_num_samps());
            uhd::rx_metadata_t md;

            uhd::stream_cmd_t start(uhd::stream_cmd_t::STREAM_MODE_START_CONTINUOUS);
            start.stream_now = true;
            rx->issue_stream_cmd(start);

            for (int i = 5; i > 0; --i) {
                snprintf(b, sizeof b, "get ready to unplug the USRP in %d...", i);
                report("action", b);
                double t = now_s();
                while (now_s() - t < 1.0) rx->recv(buf.data(), buf.size(), md, 0.1);
            }
            report("action", "============================================");
            report("action", ">>>  PULL THE USB CABLE NOW  <<<");
            report("action", "============================================");

            const double t0 = now_s();
            size_t total = 0, calls = 0, timeouts = 0;
            std::string first_error;
            double error_at = -1;
            int last_announced = -1;

            while (now_s() - t0 < 30.0) {
                size_t n = 0;
                try {
                    n = rx->recv(buf.data(), buf.size(), md, 0.5);
                } catch (const std::exception& e) {
                    first_error = std::string("recv() threw: ") + e.what();
                    error_at = now_s() - t0;
                    break;
                }
                ++calls;
                if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_TIMEOUT) {
                    ++timeouts;
                    // A run of timeouts is what an unplug looks like from here.
                    if (timeouts == 6) {
                        first_error = "sustained recv() timeouts (device stopped delivering)";
                        error_at = now_s() - t0;
                        break;
                    }
                } else if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_NONE) {
                    total += n;
                    timeouts = 0;
                } else if (md.error_code != uhd::rx_metadata_t::ERROR_CODE_OVERFLOW) {
                    first_error = std::string("recv() error: ") + md.strerror();
                    error_at = now_s() - t0;
                    break;
                }
                const int elapsed = (int)(now_s() - t0);
                if (elapsed != last_announced) {
                    last_announced = elapsed;
                    snprintf(b, sizeof b, "  still streaming... %2ds, %zu samples",
                             elapsed, total);
                    report("action", b);
                }
            }

            if (error_at >= 0) {
                snprintf(b, sizeof b, "recv() stopped cleanly after %.2fs: %s",
                         error_at, first_error.c_str());
                report("stage", b);
                report("gate8", "PASS: unplug produced a bounded error, no hang");
            } else {
                report("gate8",
                       "INCONCLUSIVE: 30s elapsed with no error - was the cable pulled?");
            }

            // Shutdown must also be bounded, which is the other half of gate 8.
            const double t1 = now_s();
            try {
                rx->issue_stream_cmd(uhd::stream_cmd_t::STREAM_MODE_STOP_CONTINUOUS);
            } catch (const std::exception& e) {
                snprintf(b, sizeof b, "stop_continuous threw (expected after unplug): %s",
                         e.what());
                report("stage", b);
            }
            snprintf(b, sizeof b, "teardown took %.2fs", now_s() - t1);
            report("stage", b);
        } catch (const std::exception& e) {
            snprintf(b, sizeof b, "unplug phase setup threw: %s", e.what());
            report("gate8", b);
        }
    }

    // --- Gate 9: was the main thread alive throughout? ----------------------
    {
        char b[128];
        snprintf(b, sizeof b, "main-thread ticks observed: %d", g_ticks.load());
        report("stage", b);
        report("gate9", g_ticks.load() > 5
               ? "PASS: browser main thread stayed responsive"
               : "FAIL: main thread appears to have been blocked");
    }

    report("done", "0");
    return nullptr;
}

// Emscripten writes stdout a character at a time, and Chrome attaches a full
// stack trace to each one, which buries UHD's log in tens of thousands of
// frames. Route UHD's own logger straight to the page instead and silence the
// console backend.
static void install_page_logger() {
    uhd::log::set_console_level(uhd::log::off);
    uhd::log::set_log_level(uhd::log::trace);
    uhd::log::add_logger("spike", [](const uhd::log::logging_info& li) {
        static const char* const names[] = {
            "TRACE","DEBUG","INFO","WARNING","ERROR","FATAL"};
        int v = (int)li.verbosity;
        const char* lvl = (v >= 0 && v <= 5) ? names[v] : "?";
        report("uhd", std::string("[") + lvl + "][" + li.component + "] " + li.message);
    });
}

extern "C" EMSCRIPTEN_KEEPALIVE void probe_start() {
    install_page_logger();
    setenv("UHD_IMAGES_DIR", "/uhd-images", 1);
    setenv("UHD_LOG_CONSOLE_LEVEL", "trace", 1);
    setenv("UHD_LOG_LEVEL", "trace", 1);
    pthread_t t;
    if (pthread_create(&t, nullptr, probe_thread, nullptr) != 0) {
        report("gate10", "FAIL: pthread_create failed");
        report("done", "1");
        return;
    }
    pthread_detach(t);
}

int main() {
    say("probe module loaded");
    MAIN_THREAD_EM_ASM({ globalThis.__probeReady && globalThis.__probeReady(); });
    return 0;
}
