#pragma once

// WebGPU-backed browser implementation of gr-fosphor's complex sink. The GNU
// Radio scheduler publishes complete IQ frames into a double buffer in shared
// WASM memory; runner/src/fosphor_webgpu.js consumes only the newest stable
// frame and performs the window, FFT, waterfall update, and drawing on the GPU.

#include <gnuradio/fft/window.h>
#include <gnuradio/sync_block.h>

#include <QWidget>

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

class FosphorWebGpuSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<FosphorWebGpuSinkWasm>;
    static constexpr std::size_t FFT_SIZE = 1024;

    static sptr make(const std::string& block_name,
                     gr::fft::window::win_type window,
                     double center_frequency,
                     double frequency_span);

    FosphorWebGpuSinkWasm(const std::string& block_name,
                          gr::fft::window::win_type window,
                          double center_frequency,
                          double frequency_span);
    ~FosphorWebGpuSinkWasm() override;

    QWidget* qwidget() const { return d_widget; }
    void set_frequency_range(double center_frequency, double frequency_span);
    void set_fft_window(gr::fft::window::win_type window);
    void publish_frequency(double frequency);

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    void publish_frame();

    QWidget* d_widget = nullptr;
    int d_renderer_id = 0;
    std::array<gr_complex, FFT_SIZE> d_pending{};
    std::size_t d_pending_size = 0;

    // Sequence zero means no frame. Sequence N is stored in buffer N & 1. The
    // release/acquire pair lets JavaScript reject a frame overwritten while it
    // was being copied without ever blocking GNU Radio's scheduler thread.
    alignas(4) std::atomic<std::uint32_t> d_sequence{ 0 };
    alignas(16) std::array<float, 2 * FFT_SIZE * 2> d_frames{};
};

extern "C" void gr_fosphor_webgpu_frequency(std::uintptr_t sink,
                                             double frequency);
