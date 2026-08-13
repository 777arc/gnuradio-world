#pragma once

// C++ rebuilds of gr-blocks' Python gr.hier_block2 compositions: the matrix
// interleaver and the stream-to-vector decimator.

#include "hier_support.hpp"
#include <gnuradio/blocks/copy.h>
#include <gnuradio/blocks/deinterleave.h>
#include <gnuradio/blocks/interleave.h>
#include <gnuradio/blocks/keep_one_in_n.h>
#include <gnuradio/blocks/stream_to_vector.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
#include <cmath>

// blocks.matrix_interleaver: write inputs into the rows of a conceptual matrix
// and read them back out by columns (or the transpose of that, deinterleaving).
// A unitary row or column count degenerates to a copy, exactly as upstream --
// deinterleave/interleave with one port would otherwise be a no-op pair.
class MatrixInterleaver : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<MatrixInterleaver>;
    static sptr make(std::size_t itemsize, int rows, int cols, bool deint)
    {
        return gnuradio::make_block_sptr<MatrixInterleaver>(itemsize, rows, cols, deint);
    }

    MatrixInterleaver(std::size_t itemsize, int rows, int cols, bool deint)
        : gr::hier_block2("matrix_interleaver",
                          gr::io_signature::make(1, 1, itemsize),
                          gr::io_signature::make(1, 1, itemsize))
    {
        if (itemsize == 0)
            throw std::runtime_error("Matrix Interleaver item size must be positive");
        if (rows < 1 || cols < 1)
            throw std::runtime_error(
                "Matrix Interleaver rows and columns must be at least 1");

        if (rows == 1 || cols == 1) {
            auto passthrough = gr::blocks::copy::make(itemsize);
            connect(self(), 0, passthrough, 0);
            connect(passthrough, 0, self(), 0);
            return;
        }

        auto deinterleaver = gr::blocks::deinterleave::make(
            itemsize, deint ? 1u : static_cast<unsigned int>(cols));
        auto interleaver = gr::blocks::interleave::make(
            itemsize, deint ? static_cast<unsigned int>(cols) : 1u);
        connect(self(), 0, deinterleaver, 0);
        for (int row = 0; row < rows; ++row)
            connect(deinterleaver, row, interleaver, row);
        connect(interleaver, 0, self(), 0);
    }
};

// blocks.stream_to_vector_decimator: vectorise the stream, then keep only every
// n'th vector so vectors come out at `vec_rate` rather than at the sample rate.
// The decimation is derived from the three rates rather than given, and both
// rate setters recompute it, which is why this is a block and not a pair of
// blocks a flowgraph could wire up itself.
class StreamToVectorDecimator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<StreamToVectorDecimator>;
    static sptr make(std::size_t itemsize,
                     double sample_rate,
                     double vec_rate,
                     std::size_t vec_len)
    {
        return gnuradio::make_block_sptr<StreamToVectorDecimator>(
            itemsize, sample_rate, vec_rate, vec_len);
    }

    StreamToVectorDecimator(std::size_t itemsize,
                            double sample_rate,
                            double vec_rate,
                            std::size_t vec_len)
        : gr::hier_block2("stream_to_vector_decimator",
                          gr::io_signature::make(1, 1, itemsize),
                          gr::io_signature::make(1, 1, itemsize * vec_len)),
          d_sample_rate(sample_rate),
          d_vec_rate(vec_rate),
          d_vec_len(vec_len)
    {
        if (itemsize == 0 || vec_len == 0)
            throw std::runtime_error(
                "Stream to Vec Decim item size and vector length must be positive");
        require_positive("Stream to Vec Decim vector rate", vec_rate);
        require_positive("Stream to Vec Decim sample rate", sample_rate);

        auto to_vector = gr::blocks::stream_to_vector::make(itemsize, vec_len);
        d_one_in_n = gr::blocks::keep_one_in_n::make(itemsize * vec_len, decimation());
        connect(self(), 0, to_vector, 0);
        connect(to_vector, 0, d_one_in_n, 0);
        connect(d_one_in_n, 0, self(), 0);
    }

    void set_sample_rate(double sample_rate)
    {
        d_sample_rate = sample_rate;
        d_one_in_n->set_n(decimation());
    }

    void set_vec_rate(double vec_rate)
    {
        d_vec_rate = vec_rate;
        d_one_in_n->set_n(decimation());
    }

    void set_decimation(int decimation) { d_one_in_n->set_n(std::max(1, decimation)); }

private:
    int decimation() const
    {
        const double ratio = d_sample_rate / static_cast<double>(d_vec_len) / d_vec_rate;
        if (!std::isfinite(ratio))
            return 1;
        return std::max(1, static_cast<int>(std::lround(ratio)));
    }

    double d_sample_rate;
    double d_vec_rate;
    std::size_t d_vec_len;
    gr::blocks::keep_one_in_n::sptr d_one_in_n;
};
