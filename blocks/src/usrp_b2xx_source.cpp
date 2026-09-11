// USRP B2xx Source: B200/B210/B200mini/B205mini/B206mini over WebUSB.
//
// Linked into the b2xx side module, not the main runner, because it pulls in all
// of UHD (see runner/modules.json runtime_modules and docs/blocks.md). libusb's
// Emscripten backend does the USB work; see docs/usrp-b2xx.md for the two patches
// in deps/patches/ without which a device hangs during initialisation.
//
// Lifecycle is load-bearing, and not the obvious one. GNU Radio's block_executor
// calls start() while the browser main thread is still blocked inside the
// scheduler constructor, and every WebUSB call from a worker proxies *to* that
// thread -- so touching UHD in the constructor or in start() deadlocks. All of it
// happens on the first work() call instead, by which time the scheduler's startup
// barrier has released and the main thread is servicing promises again.
#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>
#include <nlohmann/json.hpp>

#include <uhd/usrp/multi_usrp.hpp>
#include <uhd/utils/log_add.hpp>
#include <uhd/stream.hpp>
#include <uhd/types/tune_request.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <mutex>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <wordexp.h>

#include "registry_helpers.hpp"

// Provided by the main module: the runner holds its startup verdict while any
// block is still bringing hardware up, rather than reporting success on a timer
// while a radio is still loading its FPGA image.
extern "C" void gr_hardware_init_begin();
extern "C" void gr_hardware_init_end();
extern "C" void gr_hardware_init_note(const char* text);
// Where this block's counters go, to ride out in the runner's stats snapshot.
// A USRP has no reader worker to post them from -- see the comment beside
// gr_radio_stats_publish() in runner.cpp.
extern "C" void gr_radio_stats_publish(const char* json);

// Emscripten declares wordexp()/wordfree() in <wordexp.h> but implements neither,
// so linking UHD leaves them undefined. Its only caller is uhd::path_expandvars(),
// which already falls back to the unexpanded path when wordexp() reports an error
// -- so failing is both the smallest possible shim and the correct behaviour.
// There is no shell in a browser tab, and the image and config paths UHD expands
// are absolute MEMFS paths that need no expansion.
extern "C" {

int wordexp(const char* words, wordexp_t* pwordexp, int flags)
{
    (void)words;
    (void)flags;
    if (pwordexp) {
        pwordexp->we_wordc = 0;
        pwordexp->we_wordv = nullptr;
        pwordexp->we_offs = 0;
    }
    return WRDE_NOSPACE;
}

void wordfree(wordexp_t* pwordexp) { (void)pwordexp; }

}  // extern "C"

namespace {

// Bring-up narration, driven off UHD's own log lines.
//
// A cold board and a warm one take completely different paths through
// multi_usrp::make(), and only UHD knows which one it is on -- it decides by
// reading the USB manufacturer string, which is not something the block can see
// from here. But it announces both stages as it enters them, so a log handler is
// enough to tell the user what is happening and roughly how long it will take.
//
// Nothing here captures a block: UHD's logger list is global, has no remove, and
// outlives any flowgraph, so a captured `this` would dangle into the next run.
// Globals and one-time registration instead.
std::atomic<bool> g_loading_firmware{false};

void install_uhd_narration()
{
    static std::once_flag once;
    std::call_once(once, [] {
        uhd::log::add_logger("gr-world-b2xx", [](const uhd::log::logging_info& info) {
            if (info.message.find("Loading firmware image") != std::string::npos) {
                g_loading_firmware.store(true);
                gr_hardware_init_note("loading firmware image");
                std::printf(
                    "USRP B2xx Source: loading firmware image -- about 40 s over "
                    "USB 3.0.\n"
                    "USRP B2xx Source: the board restarts with a new USB identity "
                    "when this finishes, so this run will stop and ask you to pick "
                    "it again.\n");
            } else if (info.message.find("Loading FPGA image") != std::string::npos) {
                // Silences the heartbeat: 15 s does not need progress lines.
                gr_hardware_init_note("");
                std::printf("USRP B2xx Source: loading FPGA image -- about 15 s.\n");
            }
        });
    });
}

// Bytes per USB receive frame, and the sample payload left once the CHDR header
// is taken off it. Named because the settled report divides by it to state a cost
// per transfer, which is the number that matters here.
constexpr int kRecvFrameBytes = 16360;
constexpr double kSamplesPerFrame = (kRecvFrameBytes - 16) / 4.0;

bool is_fake(const std::string& device)
{
    return device == "fake" || device.rfind("fake:", 0) == 0;
}

// `fake:<hz>` selects the tone frequency; plain `fake` uses 1 kHz.
double fake_tone_hz(const std::string& device)
{
    if (device.rfind("fake:", 0) != 0)
        return 1000.0;
    try {
        return std::stod(device.substr(5));
    } catch (...) {
        return 1000.0;
    }
}

class usrp_b2xx_source : public gr::sync_block
{
public:
    usrp_b2xx_source(std::string device,
                     double samp_rate,
                     double center_freq,
                     double gain,
                     double bandwidth,
                     std::string antenna,
                     double master_clock_rate)
        : gr::sync_block("usrp_b2xx_source",
                         gr::io_signature::make(0, 0, 0),
                         gr::io_signature::make(1, 1, sizeof(gr_complex))),
          d_device(std::move(device)),
          d_samp_rate(samp_rate),
          d_center_freq(center_freq),
          d_gain(gain),
          d_bandwidth(bandwidth),
          d_antenna(std::move(antenna)),
          d_master_clock_rate(master_clock_rate),
          d_fake(is_fake(d_device)),
          d_tone_hz(fake_tone_hz(d_device)),
          d_pending_freq(center_freq),
          d_pending_gain(gain),
          d_pending_bandwidth(bandwidth),
          d_pending_rate(samp_rate)
    {
        // Deliberately empty of device work: see the header comment.
    }

    // Called from a QT GUI callback on the browser main thread. It must not
    // touch UHD: that would issue USB control transfers from the wrong thread,
    // while work() is mid-recv on this one. Stage the value instead; work()
    // applies it between receives.
    void set_center_freq(double hz) { stage(d_pending_freq, hz); }
    void set_gain(double db) { stage(d_pending_gain, db); }
    void set_bandwidth(double hz) { stage(d_pending_bandwidth, hz); }
    void set_samp_rate(double sps) { stage(d_pending_rate, sps); }

    bool start() override
    {
        d_started = std::chrono::steady_clock::now();
        d_produced = 0;
        return true;
    }

    bool stop() override
    {
        // The device may already be gone -- an unplug makes stop_continuous throw
        // after its ack times out. That is bounded and expected; it must not
        // escape into the scheduler's teardown.
        try {
            if (d_rx) {
                d_rx->issue_stream_cmd(
                    uhd::stream_cmd_t::STREAM_MODE_STOP_CONTINUOUS);
            }
        } catch (const std::exception& e) {
            std::printf("USRP B2xx Source: stop: %s\n", e.what());
        }
        d_rx.reset();
        d_usrp.reset();
        return true;
    }

    int work(int noutput_items,
             gr_vector_const_void_star&,
             gr_vector_void_star& output_items) override
    {
        auto* out = static_cast<gr_complex*>(output_items[0]);
        if (d_fake)
            return fake_work(noutput_items, out);
        if (d_failed)
            return -1;  // WORK_DONE: the error was already reported.
        if (!d_usrp && !open_device())
            return -1;

        apply_pending();

        uhd::rx_metadata_t md;
        size_t got = 0;
        // How long this call spends inside recv() is the one number that says
        // where a shortfall lives. Near 100% of wall time means the transport is
        // the limit -- samples are not arriving fast enough to hand over. Well
        // under means the opposite: recv() returns promptly and the scheduler is
        // away downstream, so the graph is what cannot keep up. Two clock reads
        // per call, against a few hundred calls a second.
        const auto recv_begin = std::chrono::steady_clock::now();
        try {
            got = d_rx->recv(out, noutput_items, md, 0.1);
        } catch (const std::exception& e) {
            fail(std::string("receive failed: ") + e.what());
            return -1;
        }
        const double recv_elapsed =
            std::chrono::duration<double>(std::chrono::steady_clock::now() -
                                          recv_begin).count();
        d_recv_seconds += recv_elapsed;
        if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_NONE)
            d_recv_seconds_delivering += recv_elapsed;
        ++d_calls;
        d_offered += static_cast<uint64_t>(noutput_items);

        switch (md.error_code) {
        case uhd::rx_metadata_t::ERROR_CODE_NONE:
            break;
        case uhd::rx_metadata_t::ERROR_CODE_TIMEOUT:
            ++d_timeouts;
            return 0;  // No samples yet; not an error.
        case uhd::rx_metadata_t::ERROR_CODE_OVERFLOW:
            report_overflow();
            return 0;
        default:
            fail(std::string("receive error: ") + md.strerror());
            return -1;
        }
        // Re-baseline on the first sample actually delivered rather than on the
        // stream command: between the two there is a ramp of a few hundred ms
        // during which no rate is meaningful, and averaging over it understates
        // everything that follows.
        if (got > 0 && d_produced == 0) {
            d_stream_started = std::chrono::steady_clock::now();
            d_last_report = d_stream_started;
            d_last_report_produced = 0;
            d_recv_seconds = 0.0;
            d_recv_seconds_delivering = 0.0;
            d_calls = 0;
            d_offered = 0;
            d_timeouts = 0;
        }
        d_produced += got;
        report_settled();
        publish_stats();
        return static_cast<int>(got);
    }

private:
    void stage(double& slot, double value)
    {
        std::lock_guard<std::mutex> lock(d_pending_mutex);
        slot = value;
        d_has_pending = true;
    }

    // Applied as one snapshot, so two fast slider updates cannot mix fields.
    void apply_pending()
    {
        if (!d_has_pending)
            return;
        double freq, gain, bandwidth, rate;
        {
            std::lock_guard<std::mutex> lock(d_pending_mutex);
            if (!d_has_pending)
                return;
            freq = d_pending_freq;
            gain = d_pending_gain;
            bandwidth = d_pending_bandwidth;
            rate = d_pending_rate;
            d_has_pending = false;
        }
        try {
            if (rate > 0 && rate != d_samp_rate) {
                d_usrp->set_rx_rate(rate);
                d_samp_rate = d_usrp->get_rx_rate();
            }
            if (freq != d_center_freq) {
                d_usrp->set_rx_freq(uhd::tune_request_t(freq));
                d_center_freq = freq;
            }
            if (gain != d_gain) {
                d_usrp->set_rx_gain(gain);
                d_gain = gain;
            }
            if (bandwidth > 0 && bandwidth != d_bandwidth) {
                d_usrp->set_rx_bandwidth(bandwidth);
                d_bandwidth = bandwidth;
            }
        } catch (const std::exception& e) {
            // A live change that failed leaves the device in an unknown state;
            // say so rather than carrying on with a configuration nobody chose.
            fail(std::string("live parameter change failed: ") + e.what());
        }
    }

    bool open_device()
    {
        // Where the runner's prepare step put the firmware and FPGA images.
        setenv("UHD_IMAGES_DIR", "/uhd-images", 1);
        gr_hardware_init_begin();
        struct InitGuard {
            ~InitGuard() { gr_hardware_init_end(); }
        } guard;
        install_uhd_narration();
        g_loading_firmware.store(false);
        try {
            uhd::device_addr_t args;
            if (!d_device.empty())
                args["serial"] = d_device;

            // Host-side USB buffering, and the one transport setting that has to
            // differ from UHD's desktop defaults. Those are 16 frames of 8176
            // bytes: 32704 sc16 samples, so the device's FIFO overflows if the
            // host stops draining for 33 ms at 1 MS/s. Reasonable on a desktop,
            // wrong here -- every WebUSB transfer completes on the browser main
            // thread, which is also where Qt repaints this flowgraph's plots, and
            // one waterfall update passes 33 ms without trying. So the bare
            // receive loop in the feasibility probe ran clean at 1 MS/s while the
            // same rate under a GUI flowgraph overruns immediately.
            //
            // 16360 is the largest frame the FX3 accepts, and is deliberately
            // neither a multiple of 8 nor of the 512/1024-byte max transfer, so
            // UHD does not coerce it. 128 of them is 2.1 MB of heap in flight --
            // half a second of slack at 1 MS/s, 26 ms at 20 -- against 130 KB
            // before.
            args["recv_frame_size"] = std::to_string(kRecvFrameBytes);
            args["num_recv_frames"] = "128";

            d_usrp = uhd::usrp::multi_usrp::make(args);

            if (d_master_clock_rate > 0)
                d_usrp->set_master_clock_rate(d_master_clock_rate);
            d_usrp->set_rx_rate(d_samp_rate);
            d_usrp->set_rx_freq(uhd::tune_request_t(d_center_freq));
            d_usrp->set_rx_gain(d_gain);
            if (d_bandwidth > 0)
                d_usrp->set_rx_bandwidth(d_bandwidth);
            if (!d_antenna.empty())
                d_usrp->set_rx_antenna(d_antenna);

            // UHD coerces silently; say so rather than letting a flowgraph run at
            // a rate nobody asked for.
            const double actual_rate = d_usrp->get_rx_rate();
            if (std::abs(actual_rate - d_samp_rate) > 1.0) {
                std::printf("USRP B2xx Source: requested %.0f S/s, got %.0f S/s\n",
                            d_samp_rate, actual_rate);
            }
            std::printf("USRP B2xx Source: %s, %.3f MS/s, %.3f MHz\n",
                        d_usrp->get_mboard_name().c_str(),
                        actual_rate / 1e6,
                        d_usrp->get_rx_freq() / 1e6);

            uhd::stream_args_t stream_args("fc32", "sc16");
            stream_args.channels = { 0 };
            d_rx = d_usrp->get_rx_stream(stream_args);

            uhd::stream_cmd_t cmd(uhd::stream_cmd_t::STREAM_MODE_START_CONTINUOUS);
            cmd.stream_now = true;
            d_rx->issue_stream_cmd(cmd);
            // Not start(): on a cold board that was minutes ago, spent loading
            // firmware and the FPGA image, and averaging over it would report a
            // delivered rate near zero no matter how well the stream then runs.
            d_stream_started = std::chrono::steady_clock::now();
            d_last_report = d_stream_started;
            d_last_report_produced = 0;
            d_produced = 0;
            return true;
        } catch (const std::exception& e) {
            // The expected end of a cold board's first run, not a fault. UHD has
            // just written the firmware; the board reset, came back with its real
            // serial number, and this origin's WebUSB permission -- keyed to the
            // identity it had a moment ago -- no longer matches it. UHD spent its
            // three-second re-enumeration window finding nothing and gave up.
            // Say what to do rather than reporting whatever it threw.
            if (g_loading_firmware.load()) {
                std::printf(
                    "USRP B2xx Source: firmware loaded. The board has restarted "
                    "with its real serial number, which this browser has not been "
                    "given access to yet.\n"
                    "USRP B2xx Source: press Run again and pick the USRP when the "
                    "browser asks. That run loads the FPGA image (about 15 s) and "
                    "then streams; both steps are once per power cycle.\n");
                d_failed = true;
                d_rx.reset();
                d_usrp.reset();
                return false;
            }
            fail(std::string("could not open device: ") + e.what());
            return false;
        }
    }

    void fail(const std::string& message)
    {
        d_failed = true;
        d_rx.reset();
        d_usrp.reset();
        std::printf("USRP B2xx Source: %s\n", message.c_str());
    }

    // Overruns are counted rather than printed one by one: a graph that cannot
    // keep up produces hundreds a second, and the console pane is shared.
    //
    // Nothing is said about the first few at all. A couple as the stream comes up
    // are normal and cost nothing, and reporting them reads as a failure during
    // the one moment the user is watching hardest. A graph in real trouble
    // produces hundreds a second, so it still reaches the threshold immediately.
    void report_overflow()
    {
        ++d_overflows;
        if (d_overflows < d_next_report)
            return;
        d_next_report *= 2;

        // The count alone cannot tell a burst at stream start from a graph that
        // is steadily losing samples; the delivered rate can. Measured over the
        // window since the last report, not since the stream began, so a rough
        // start does not go on colouring every later line.
        using namespace std::chrono;
        const auto now = steady_clock::now();
        const double window = duration<double>(now - d_last_report).count();
        const uint64_t produced = d_produced - d_last_report_produced;
        d_last_report = now;
        d_last_report_produced = d_produced;

        if (window < 0.5) {
            // Too short to divide by: this is a burst, and a rate computed over
            // it would be noise presented as a measurement.
            std::printf("USRP B2xx Source: %llu overrun(s) at %.3f MS/s\n",
                        (unsigned long long)d_overflows, d_samp_rate / 1e6);
            return;
        }
        std::printf("USRP B2xx Source: %llu overrun(s); delivering %.3f of "
                    "%.3f MS/s\n",
                    (unsigned long long)d_overflows,
                    produced / window / 1e6,
                    d_samp_rate / 1e6);
    }

    // Help > SDR Receive Speed Test reads these, and so does the diagnostics
    // snapshot. Once a second: the snapshot is polled far more often than that,
    // and formatting JSON on a streaming block's thread is not free.
    void publish_stats()
    {
        using namespace std::chrono;
        const auto now = steady_clock::now();
        if (duration<double>(now - d_last_publish).count() < 1.0)
            return;
        d_last_publish = now;
        const double elapsed = duration<double>(now - d_stream_started).count();
        const double delivered = elapsed > 0 ? d_produced / elapsed : 0.0;
        // What the device produced and this block did not take. Reported as lost
        // rather than inferred from the overrun count, which says how many times
        // the stream broke and nothing about how much went missing.
        const double expected = d_samp_rate * elapsed;
        const double lost = expected > (double)d_produced
                                ? expected - (double)d_produced : 0.0;
        char buffer[512];
        std::snprintf(buffer, sizeof buffer,
                      "{\"device\":\"USRP B2xx\",\"direction\":\"rx\","
                      "\"serial\":\"%s\",\"requestedRate\":%.0f,"
                      "\"actualRate\":%.0f,\"overruns\":%llu,"
                      "\"droppedSamples\":%.0f,\"state\":\"running\"}",
                      d_device.empty() ? "first available" : d_device.c_str(),
                      d_samp_rate,
                      delivered,
                      (unsigned long long)d_overflows,
                      lost);
        gr_radio_stats_publish(buffer);
    }

    // One line a few seconds in, saying what the radio is actually delivering.
    // UHD coerces sample rates silently and a browser tab drops samples, so "the
    // graph started" is not the same as "it is keeping up" and nothing else in
    // the console pane distinguishes them.
    void report_settled()
    {
        if (d_settled)
            return;
        using namespace std::chrono;
        const double elapsed =
            duration<double>(steady_clock::now() - d_stream_started).count();
        // Eight seconds, not five: the first few carry the stream ramping up and
        // the plots allocating their history, and reading them in reads a run as
        // 10% worse than it settles at -- enough to trip the shortfall
        // breakdown below on a flowgraph that is fine.
        if (elapsed < 8.0)
            return;
        d_settled = true;
        const double delivered = d_produced / elapsed;
        std::printf("USRP B2xx Source: streaming %.3f of %.3f MS/s, %llu "
                    "overrun(s) so far\n",
                    delivered / 1e6,
                    d_samp_rate / 1e6,
                    (unsigned long long)d_overflows);
        if (delivered >= 0.9 * d_samp_rate)
            return;

        // Only when something is actually wrong: one line is handholding, two is
        // clutter. Reading it: recv% near 100 with a full offered buffer is a
        // transport limit, and recv% low is the graph downstream failing to
        // consume. Samples per call far below what was offered means recv() is
        // returning a fragment at a time, which is a third thing again.
        std::printf("USRP B2xx Source:   %llu recv calls in %.1fs, %.0f%% of it "
                    "inside recv(); %.0f samples per call of %.0f offered; "
                    "%llu timeout(s)\n",
                    (unsigned long long)d_calls,
                    elapsed,
                    d_calls ? 100.0 * d_recv_seconds / elapsed : 0.0,
                    d_calls ? double(d_produced) / double(d_calls) : 0.0,
                    d_calls ? double(d_offered) / double(d_calls) : 0.0,
                    (unsigned long long)d_timeouts);
        // The cost of one USB transfer. Deliberately divides only the time spent
        // in calls that *delivered* by the frames they delivered: counting time
        // spent handling overflows and timeouts against a frame count that
        // excludes them inflates this exactly when a run is going badly, which
        // is when it is being read.
        const double frames = d_produced / kSamplesPerFrame;
        std::printf("USRP B2xx Source:   %d-byte frames: %.0f of them, %.2f ms "
                    "each\n",
                    kRecvFrameBytes,
                    frames,
                    frames > 0 ? 1000.0 * d_recv_seconds_delivering / frames
                               : 0.0);
    }

    // Paced half-scale tone, for tests and for building a flowgraph with no
    // hardware attached. Opens no USB and fetches no images.
    int fake_work(int noutput_items, gr_complex* out)
    {
        using namespace std::chrono;
        const double elapsed =
            duration<double>(steady_clock::now() - d_started).count();
        const auto due = static_cast<uint64_t>(elapsed * d_samp_rate);
        if (due <= d_produced)
            return 0;
        const int n = std::min<int>(noutput_items,
                                    static_cast<int>(due - d_produced));
        const double step = 2.0 * M_PI * d_tone_hz / d_samp_rate;
        for (int i = 0; i < n; ++i) {
            const double phase = step * static_cast<double>(d_produced + i);
            out[i] = gr_complex(0.5f * std::cos(phase), 0.5f * std::sin(phase));
        }
        d_produced += n;
        return n;
    }

    const std::string d_device;
    double d_samp_rate;
    double d_center_freq;
    double d_gain;
    double d_bandwidth;
    const std::string d_antenna;
    const double d_master_clock_rate;
    const bool d_fake;
    const double d_tone_hz;

    uhd::usrp::multi_usrp::sptr d_usrp;
    uhd::rx_streamer::sptr d_rx;
    bool d_failed = false;
    uint64_t d_overflows = 0;
    uint64_t d_next_report = 8;
    std::chrono::steady_clock::time_point d_last_report{};
    uint64_t d_last_report_produced = 0;
    bool d_settled = false;
    double d_recv_seconds = 0.0;
    double d_recv_seconds_delivering = 0.0;
    uint64_t d_calls = 0;
    uint64_t d_offered = 0;
    uint64_t d_timeouts = 0;

    std::mutex d_pending_mutex;
    bool d_has_pending = false;
    double d_pending_freq = 0;
    double d_pending_gain = 0;
    double d_pending_bandwidth = 0;
    double d_pending_rate = 0;

    std::chrono::steady_clock::time_point d_started{};
    std::chrono::steady_clock::time_point d_stream_started{};
    std::chrono::steady_clock::time_point d_last_publish{};
    uint64_t d_produced = 0;
};

}  // namespace

// Registered by the generated b2xx registrar (runner/gen_registry.py).
BuiltBlock make_wasm_usrp_b2xx_source(const nlohmann::json& params)
{
    auto block = std::make_shared<usrp_b2xx_source>(
        wasm_registry::text(params, "device"),
        wasm_registry::number<double>(params, "samp_rate", 1e6),
        wasm_registry::number<double>(params, "center_freq", 100e6),
        wasm_registry::number<double>(params, "gain", 30.0),
        wasm_registry::number<double>(params, "bandwidth", 0.0),
        wasm_registry::text(params, "antenna", "RX2"),
        wasm_registry::number<double>(params, "master_clock_rate", 0.0));
    BuiltBlock result{ block };
    // Without these a QT GUI Range bound to the parameter moves and publishes
    // while the block keeps its construction-time value, silently.
    result.numeric_setters["center_freq"] =
        [block](double value) { block->set_center_freq(value); };
    result.numeric_setters["gain"] =
        [block](double value) { block->set_gain(value); };
    result.numeric_setters["bandwidth"] =
        [block](double value) { block->set_bandwidth(value); };
    result.numeric_setters["samp_rate"] =
        [block](double value) { block->set_samp_rate(value); };
    return result;
}
