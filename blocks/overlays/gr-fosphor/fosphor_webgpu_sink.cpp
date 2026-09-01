#include "fosphor_webgpu_sink.hpp"

#include <gnuradio/io_signature.h>
#include <pmt/pmt.h>

#include <emscripten.h>

#include <algorithm>
#include <cstring>
#include <stdexcept>

FosphorWebGpuSinkWasm::sptr FosphorWebGpuSinkWasm::make(
    const std::string& block_name,
    gr::fft::window::win_type window,
    double center_frequency,
    double frequency_span)
{
    return gnuradio::make_block_sptr<FosphorWebGpuSinkWasm>(
        block_name, window, center_frequency, frequency_span);
}

FosphorWebGpuSinkWasm::FosphorWebGpuSinkWasm(
    const std::string& block_name,
    gr::fft::window::win_type window,
    double center_frequency,
    double frequency_span)
    : gr::sync_block(block_name,
                     gr::io_signature::make(1, 1, sizeof(gr_complex)),
                     gr::io_signature::make(0, 0, 0)),
      d_widget(new QWidget)
{
    static_assert(std::atomic<std::uint32_t>::is_always_lock_free,
                  "WebGPU frame publication requires lock-free 32-bit atomics");

    d_widget->setMinimumSize(640, 560);
    d_widget->setFocusPolicy(Qt::StrongFocus);
    d_widget->setStyleSheet(QStringLiteral("background:#05070b;"));

    message_port_register_out(pmt::mp("freq"));

    d_renderer_id = MAIN_THREAD_EM_ASM_INT(
        {
            const manager = globalThis.__grFosphorWebGpu;
            if (!manager || !manager.ready)
                return 0;
            return manager.create({
                memory: wasmMemory,
                controlPointer: $0,
                samplesPointer: $1,
                sinkPointer: $2,
                centerFrequency: $3,
                frequencySpan: $4,
                windowType: $5,
                blockName: UTF8ToString($6),
                publishFrequency: (sink, frequency) =>
                    _gr_fosphor_webgpu_frequency(sink, frequency),
            });
        },
        reinterpret_cast<std::uintptr_t>(&d_sequence),
        reinterpret_cast<std::uintptr_t>(d_frames.data()),
        reinterpret_cast<std::uintptr_t>(this),
        center_frequency,
        frequency_span,
        static_cast<int>(window),
        block_name.c_str());
    if (!d_renderer_id)
        throw std::runtime_error("WebGPU fosphor canvas initialization failed");

    // Qt for WASM draws all widgets into its own canvas, so this WebGPU canvas
    // has to be kept aligned over the placeholder. That geometry comes from the
    // runner's own widget report (publish_gui_layout() in runner.cpp), which
    // fosphor_webgpu.js applies -- no timer here, and no scheduler thread
    // touching Qt or the DOM.
}

FosphorWebGpuSinkWasm::~FosphorWebGpuSinkWasm()
{
    if (d_renderer_id) {
        MAIN_THREAD_EM_ASM(
            {
                const manager = globalThis.__grFosphorWebGpu;
                if (manager)
                    manager.destroy($0);
            },
            d_renderer_id);
    }
}

void FosphorWebGpuSinkWasm::set_frequency_range(double center_frequency,
                                                 double frequency_span)
{
    if (!d_renderer_id)
        return;
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grFosphorWebGpu;
            if (manager)
                manager.setFrequencyRange($0, $1, $2);
        },
        d_renderer_id,
        center_frequency,
        frequency_span);
}

void FosphorWebGpuSinkWasm::set_fft_window(gr::fft::window::win_type window)
{
    if (!d_renderer_id)
        return;
    MAIN_THREAD_EM_ASM(
        {
            const manager = globalThis.__grFosphorWebGpu;
            if (manager)
                manager.setWindow($0, $1);
        },
        d_renderer_id,
        static_cast<int>(window));
}

void FosphorWebGpuSinkWasm::publish_frequency(double frequency)
{
    const auto port = pmt::mp("freq");
    message_port_pub(port, pmt::cons(port, pmt::from_double(frequency)));
}

int FosphorWebGpuSinkWasm::work(int noutput_items,
                                gr_vector_const_void_star& input_items,
                                gr_vector_void_star&)
{
    const auto* input = static_cast<const gr_complex*>(input_items[0]);
    int consumed = 0;
    while (consumed < noutput_items) {
        const std::size_t count = std::min<std::size_t>(
            FFT_SIZE - d_pending_size,
            static_cast<std::size_t>(noutput_items - consumed));
        std::memcpy(d_pending.data() + d_pending_size,
                    input + consumed,
                    count * sizeof(gr_complex));
        consumed += static_cast<int>(count);
        d_pending_size += count;
        if (d_pending_size == FFT_SIZE) {
            publish_frame();
            d_pending_size = 0;
        }
    }
    return noutput_items;
}

void FosphorWebGpuSinkWasm::publish_frame()
{
    const std::uint32_t sequence =
        d_sequence.load(std::memory_order_relaxed) + 1;
    float* destination =
        d_frames.data() + (sequence & 1) * FFT_SIZE * 2;
    for (std::size_t index = 0; index < FFT_SIZE; ++index) {
        destination[2 * index] = d_pending[index].real();
        destination[2 * index + 1] = d_pending[index].imag();
    }
    d_sequence.store(sequence, std::memory_order_release);
}

extern "C" EMSCRIPTEN_KEEPALIVE void gr_fosphor_webgpu_frequency(
    std::uintptr_t sink,
    double frequency)
{
    if (sink)
        reinterpret_cast<FosphorWebGpuSinkWasm*>(sink)->publish_frequency(frequency);
}
