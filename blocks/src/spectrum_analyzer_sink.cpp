#include "spectrum_analyzer_sink.hpp"

#include <gnuradio/io_signature.h>

#include <emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numeric>
#include <stdexcept>

namespace {

std::vector<float> make_window(gr::fft::window::win_type type, int size)
{
    const double parameter = type == gr::fft::window::WIN_KAISER
                                 ? 6.76
                                 : gr::fft::window::INVALID_WIN_PARAM;
    return gr::fft::window::build(type, size, parameter, false);
}

} // namespace

SpectrumAnalyzerSinkWasm::sptr SpectrumAnalyzerSinkWasm::make(
    const std::string& instance_name,
    const std::string& display_title,
    const std::string& input_type,
    double sample_rate,
    double center_frequency,
    int fft_size,
    gr::fft::window::win_type window_type,
    double update_time,
    double average,
    const std::string& trace_mode,
    double reference_level,
    double db_per_division,
    double level_offset_db,
    const std::string& level_unit,
    bool peak_track,
    double obw_percent,
    double obw_span)
{
    return gnuradio::make_block_sptr<SpectrumAnalyzerSinkWasm>(
        instance_name,
        display_title,
        input_type,
        sample_rate,
        center_frequency,
        fft_size,
        window_type,
        update_time,
        average,
        trace_mode,
        reference_level,
        db_per_division,
        level_offset_db,
        level_unit,
        peak_track,
        obw_percent,
        obw_span);
}

SpectrumAnalyzerSinkWasm::SpectrumAnalyzerSinkWasm(
    const std::string& instance_name,
    const std::string& display_title,
    const std::string& input_type,
    double sample_rate,
    double center_frequency,
    int fft_size,
    gr::fft::window::win_type window_type,
    double update_time,
    double average,
    const std::string& trace_mode,
    double reference_level,
    double db_per_division,
    double level_offset_db,
    const std::string& level_unit,
    bool peak_track,
    double obw_percent,
    double obw_span)
    : gr::sync_block(instance_name,
                     gr::io_signature::make(
                         1,
                         1,
                         input_type == "float" ? sizeof(float) : sizeof(gr_complex)),
                     gr::io_signature::make(0, 0, 0)),
      d_is_float(input_type == "float"),
      d_fft_size(fft_size),
      d_bin_count(d_is_float ? fft_size / 2 + 1 : fft_size),
      d_window(make_window(window_type, fft_size)),
      d_ring(static_cast<std::size_t>(fft_size)),
      d_frames(static_cast<std::size_t>(2 * d_bin_count)),
      d_update_time(std::max(0.02, update_time)),
      d_next_analysis(std::chrono::steady_clock::now()),
      d_widget(new QWidget)
{
    if (input_type != "complex" && input_type != "float")
        throw std::runtime_error(
            "Spectrum Analyzer input type must be complex or float");
    if (fft_size < 256 || fft_size > 65536 || (fft_size & (fft_size - 1)) != 0)
        throw std::runtime_error(
            "Spectrum Analyzer FFT size must be a power of two from 256 to 65536");
    if (!(sample_rate > 0.0))
        throw std::runtime_error("Spectrum Analyzer sample rate must be positive");
    if (!(db_per_division > 0.0))
        throw std::runtime_error("Spectrum Analyzer dB/division must be positive");
    if (!(obw_percent > 0.0 && obw_percent < 100.0))
        throw std::runtime_error(
            "Spectrum Analyzer occupied bandwidth percentage must be between 0 and 100");

    static_assert(std::atomic<std::uint32_t>::is_always_lock_free,
                  "Spectrum Analyzer frame publication requires lock-free 32-bit atomics");

    d_window_sum = std::accumulate(d_window.begin(), d_window.end(), 0.0);
    const double square_sum = std::inner_product(
        d_window.begin(), d_window.end(), d_window.begin(), 0.0);
    if (std::fabs(d_window_sum) < 1e-12)
        throw std::runtime_error("Spectrum Analyzer window has zero coherent gain");
    d_enbw_bins = d_fft_size * square_sum / (d_window_sum * d_window_sum);

    if (d_is_float)
        d_real_fft = std::make_unique<gr::fft::fft_real_fwd>(d_fft_size, 1);
    else
        d_complex_fft = std::make_unique<gr::fft::fft_complex_fwd>(d_fft_size, 1);

    d_widget->setMinimumSize(520, 300);
    d_widget->setFocusPolicy(Qt::StrongFocus);
    d_widget->setStyleSheet(QStringLiteral("background:#050914;"));

    d_renderer_id = MAIN_THREAD_EM_ASM_INT(
        {
            const manager = globalThis.__grSpectrumAnalyzer;
            if (!manager) return 0;
            return manager.create({
                memory: wasmMemory,
                controlPointer: $0,
                framesPointer: $1,
                binCount: $2,
                fftSize: $3,
                isFloat: !!$4,
            });
        },
        reinterpret_cast<std::uintptr_t>(&d_sequence),
        reinterpret_cast<std::uintptr_t>(d_frames.data()),
        d_bin_count,
        d_fft_size,
        d_is_float ? 1 : 0);
    if (!d_renderer_id)
        throw std::runtime_error("Spectrum Analyzer browser renderer initialization failed");

    // EM_ASM's argument substitution is single-digit in this toolchain. Keep
    // configuration in small calls rather than creating a fragile $10+ call.
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grSpectrumAnalyzer;
            if (manager) manager.configureNumeric(
                $0, $1, $2, $3, $4, $5, $6, $7, !!$8);
        },
        d_renderer_id,
        sample_rate,
        center_frequency,
        d_enbw_bins,
        std::clamp(average, 0.0001, 1.0),
        reference_level,
        db_per_division,
        level_offset_db,
        peak_track ? 1 : 0);
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grSpectrumAnalyzer;
            if (manager) manager.configureMeasurement($0, $1, $2);
        },
        d_renderer_id,
        obw_percent,
        std::max(0.0, obw_span));
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grSpectrumAnalyzer;
            if (manager) manager.configureText(
                $0, UTF8ToString($1), UTF8ToString($2),
                UTF8ToString($3), UTF8ToString($4));
        },
        d_renderer_id,
        instance_name.c_str(),
        display_title.c_str(),
        trace_mode.c_str(),
        level_unit.c_str());

    // No geometry timer here. The runner publishes every placed widget's
    // rectangle whenever the arrangement changes (publish_gui_layout() in
    // runner.cpp, which is event-driven with the 3 Hz sweep as its backstop),
    // and spectrum_analyzer.js positions this renderer from that report. One
    // notification serves every browser-native sink, so adding another such
    // sink does not add another poller.
}

SpectrumAnalyzerSinkWasm::~SpectrumAnalyzerSinkWasm()
{
    if (!d_renderer_id)
        return;
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grSpectrumAnalyzer;
            if (manager) manager.destroy($0);
        },
        d_renderer_id);
}

void SpectrumAnalyzerSinkWasm::publish_number(const char* method, double value)
{
    if (!d_renderer_id)
        return;
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grSpectrumAnalyzer;
            if (manager && typeof manager[UTF8ToString($0)] === 'function')
                manager[UTF8ToString($0)]($1, $2);
        },
        method,
        d_renderer_id,
        value);
}

void SpectrumAnalyzerSinkWasm::set_sample_rate(double value)
{
    if (value > 0.0)
        publish_number("setSampleRate", value);
}

void SpectrumAnalyzerSinkWasm::set_center_frequency(double value)
{
    publish_number("setCenterFrequency", value);
}

void SpectrumAnalyzerSinkWasm::set_update_time(double value)
{
    d_update_time.store(std::max(0.02, value), std::memory_order_relaxed);
}

void SpectrumAnalyzerSinkWasm::set_average(double value)
{
    publish_number("setAverage", std::clamp(value, 0.0001, 1.0));
}

void SpectrumAnalyzerSinkWasm::set_reference_level(double value)
{
    publish_number("setReferenceLevel", value);
}

void SpectrumAnalyzerSinkWasm::set_db_per_division(double value)
{
    if (value > 0.0)
        publish_number("setDbPerDivision", value);
}

void SpectrumAnalyzerSinkWasm::set_level_offset_db(double value)
{
    publish_number("setLevelOffsetDb", value);
}

void SpectrumAnalyzerSinkWasm::set_obw_percent(double value)
{
    if (value > 0.0 && value < 100.0)
        publish_number("setObwPercent", value);
}

void SpectrumAnalyzerSinkWasm::set_obw_span(double value)
{
    publish_number("setObwSpan", std::max(0.0, value));
}

int SpectrumAnalyzerSinkWasm::work(int noutput_items,
                                   gr_vector_const_void_star& input_items,
                                   gr_vector_void_star&)
{
    if (d_is_float) {
        const auto* input = static_cast<const float*>(input_items[0]);
        for (int index = 0; index < noutput_items; ++index) {
            d_ring[d_write_position] = gr_complex(input[index], 0.0F);
            d_write_position = (d_write_position + 1) % d_ring.size();
        }
    } else {
        const auto* input = static_cast<const gr_complex*>(input_items[0]);
        for (int index = 0; index < noutput_items; ++index) {
            d_ring[d_write_position] = input[index];
            d_write_position = (d_write_position + 1) % d_ring.size();
        }
    }
    d_samples_seen += static_cast<std::uint64_t>(noutput_items);

    const auto now = std::chrono::steady_clock::now();
    if (d_samples_seen >= static_cast<std::uint64_t>(d_fft_size) &&
        now >= d_next_analysis) {
        analyze();
        d_next_analysis = now + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                    std::chrono::duration<double>(d_update_time.load(
                                        std::memory_order_relaxed)));
    }
    return noutput_items;
}

void SpectrumAnalyzerSinkWasm::analyze()
{
    const double scale = 1.0 / (d_window_sum * d_window_sum);
    const std::uint32_t sequence =
        d_sequence.load(std::memory_order_relaxed) + 1;
    float* destination =
        d_frames.data() + static_cast<std::size_t>(sequence & 1) * d_bin_count;

    if (d_is_float) {
        float* fft_input = d_real_fft->get_inbuf();
        for (int index = 0; index < d_fft_size; ++index) {
            const std::size_t ring_index =
                (d_write_position + static_cast<std::size_t>(index)) % d_ring.size();
            fft_input[index] = d_ring[ring_index].real() * d_window[index];
        }
        d_real_fft->execute();
        const gr_complex* output = d_real_fft->get_outbuf();
        for (int index = 0; index < d_bin_count; ++index) {
            double power = std::norm(output[index]) * scale;
            // A real sinusoid has half its amplitude in each spectral half. The
            // negative half is hidden, so double amplitude (4x power) away from
            // DC/Nyquist to make a full-scale bin-centered sinusoid read 0 dBFS.
            if (index != 0 && index != d_fft_size / 2)
                power *= 4.0;
            destination[index] = static_cast<float>(std::max(power, 1e-30));
        }
    } else {
        gr_complex* fft_input = d_complex_fft->get_inbuf();
        for (int index = 0; index < d_fft_size; ++index) {
            const std::size_t ring_index =
                (d_write_position + static_cast<std::size_t>(index)) % d_ring.size();
            fft_input[index] = d_ring[ring_index] * d_window[index];
        }
        d_complex_fft->execute();
        const gr_complex* output = d_complex_fft->get_outbuf();
        for (int index = 0; index < d_fft_size; ++index) {
            const int shifted = (index + d_fft_size / 2) % d_fft_size;
            destination[index] = static_cast<float>(
                std::max(std::norm(output[shifted]) * scale, 1e-30));
        }
    }

    d_sequence.store(sequence, std::memory_order_release);
}
