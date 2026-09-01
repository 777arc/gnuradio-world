#pragma once

// Browser-native spectrum analyzer. The GNU Radio scheduler thread keeps the
// newest input frame, performs a rate-limited FFT, and publishes normalized
// linear-power bins through a versioned double buffer in shared WASM memory.
// runner/src/spectrum_analyzer.js owns all display state and interaction.

#include <gnuradio/fft/fft.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/sync_block.h>

#include <QWidget>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

class SpectrumAnalyzerSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<SpectrumAnalyzerSinkWasm>;

    static sptr make(const std::string& instance_name,
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
                     double obw_span);

    SpectrumAnalyzerSinkWasm(const std::string& instance_name,
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
                             double obw_span);
    ~SpectrumAnalyzerSinkWasm() override;

    QWidget* qwidget() const { return d_widget; }

    void set_sample_rate(double value);
    void set_center_frequency(double value);
    void set_update_time(double value);
    void set_average(double value);
    void set_reference_level(double value);
    void set_db_per_division(double value);
    void set_level_offset_db(double value);
    void set_obw_percent(double value);
    void set_obw_span(double value);

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    void analyze();
    void publish_number(const char* method, double value);

    bool d_is_float;
    int d_fft_size;
    int d_bin_count;
    std::vector<float> d_window;
    double d_window_sum = 1.0;
    double d_enbw_bins = 1.0;
    std::unique_ptr<gr::fft::fft_complex_fwd> d_complex_fft;
    std::unique_ptr<gr::fft::fft_real_fwd> d_real_fft;

    std::vector<gr_complex> d_ring;
    std::size_t d_write_position = 0;
    std::uint64_t d_samples_seen = 0;

    alignas(4) std::atomic<std::uint32_t> d_sequence{ 0 };
    std::vector<float> d_frames;

    std::atomic<double> d_update_time;
    std::chrono::steady_clock::time_point d_next_analysis;

    QWidget* d_widget = nullptr;
    int d_renderer_id = 0;
};
