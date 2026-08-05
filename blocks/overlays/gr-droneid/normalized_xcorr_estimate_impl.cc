// WASM-portable build of gr-droneid's normalized_xcorr_estimate_impl.cc.
// Keep this source aligned with the requested upstream branch. Two behavioral
// changes: the explicit size_t cast in num_steps (wasm32 defines uint64_t and
// size_t as different unsigned types, so upstream's std::min call does not
// instantiate there) and the num_steps == 0 early return (see general_work).

#include "normalized_xcorr_estimate_impl.h"
#include <gnuradio/io_signature.h>

#include <gnuradio/droneid/misc_utils.h>
#include <numeric>
#include <volk/volk.h>

namespace gr {
namespace droneid {

normalized_xcorr_estimate::sptr
normalized_xcorr_estimate::make(const std::vector<gr_complex>& taps)
{
    return gnuradio::get_initial_sptr(new normalized_xcorr_estimate_impl(taps));
}

normalized_xcorr_estimate_impl::normalized_xcorr_estimate_impl(
    const std::vector<gr_complex>& taps)
    : gr::block("dot_prod",
                gr::io_signature::make(1, 1, sizeof(gr_complex)),
                gr::io_signature::make(1, 1, sizeof(gr_complex))),
      taps_(taps),
      window_size_(taps.size())
{
    const auto mean = std::accumulate(taps_.begin(), taps_.end(), gr_complex{ 0, 0 }) /
                      static_cast<float>(taps_.size());

    for (auto& tap : taps_)
        tap = std::conj(tap) - mean;

    taps_var_ = misc_utils::var_no_mean(&taps_[0], taps_.size());
    window_size_recip_ = 1.0f / static_cast<float>(window_size_);
    window_size_recip_complex_ = gr_complex{ window_size_recip_, 0 };
}

normalized_xcorr_estimate_impl::~normalized_xcorr_estimate_impl() = default;

int normalized_xcorr_estimate_impl::general_work(
    int noutput_items,
    gr_vector_int& ninput_items,
    gr_vector_const_void_star& input_items,
    gr_vector_void_star& output_items)
{
    const auto* in = static_cast<const gr_complex*>(input_items[0]);
    auto* out = static_cast<gr_complex*>(output_items[0]);

    consume_each(noutput_items);
    buffer_.insert(buffer_.end(), in, in + noutput_items);
    if (buffer_.size() < window_size_)
        return 0;

    const auto num_steps =
        std::min(static_cast<std::size_t>(noutput_items), buffer_.size() - window_size_);

    // A call that leaves the history exactly one window long has no correlation
    // step to take, and the code below is not written for that case: the scratch
    // vectors are only ever grown (`sums_.size() < num_steps` is false at zero),
    // yet the magnitude pass still writes num_steps + window_size_ floats and
    // vars_[0] is still assigned. On the first such call those vectors have no
    // storage at all, so both write through a null data pointer and corrupt low
    // memory; the flowgraph then dies some milliseconds later as an opaque
    // Emscripten `Aborted()` or a renderer segfault at a wild address.
    // window_size_ is the 1024-tap Zadoff-Chu preamble at every DroneID rate and
    // the scheduler's first chunk is routinely exactly 1024 items, which is why
    // the droneid examples hit this on most runs rather than rarely.
    if (num_steps == 0)
        return 0;

    if (sums_.size() < num_steps) {
        sums_.resize(num_steps);
        abs_squared_.resize(num_steps + window_size_);
        vars_.resize(num_steps);
    }

    volk_32fc_magnitude_squared_32f(
        &abs_squared_[0], &buffer_[0], num_steps + window_size_);
    auto running_var =
        std::accumulate(abs_squared_.begin(), abs_squared_.begin() + window_size_, 0.f);
    vars_[0] = running_var;

    volk_32fc_x2_dot_prod_32fc(&out[0], &buffer_[0], &taps_[0], window_size_);

    for (uint32_t idx = 1; idx < num_steps; idx++) {
        running_var = running_var - abs_squared_[idx - 1] +
                      abs_squared_[idx + window_size_];
        vars_[idx] = running_var;
        volk_32fc_x2_dot_prod_32fc(&out[idx], &buffer_[idx], &taps_[0], window_size_);
    }

    volk_32fc_s32fc_multiply_32fc(
        &out[0], &out[0], window_size_recip_complex_, num_steps);
    volk_32f_s32f_multiply_32f(&vars_[0], &vars_[0], window_size_recip_, num_steps);
    volk_32f_s32f_multiply_32f(&vars_[0], &vars_[0], taps_var_, num_steps);
    volk_32f_invsqrt_32f(&vars_[0], &vars_[0], num_steps);
    volk_32fc_32f_multiply_32fc(&out[0], &out[0], &vars_[0], num_steps);

    for (uint32_t idx = 0; idx < num_steps; idx++) {
        if (out[idx].real() == FP_NAN || out[idx].imag() == FP_NAN)
            out[idx] = zero_complex_;
    }

    buffer_.erase(buffer_.begin(), buffer_.begin() + num_steps);
    return num_steps;
}

} // namespace droneid
} // namespace gr
