// Runner-only sink that prints a byte stream to the console under the flowgraph.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A decoder whose output is text -- gr-ham's Varicode Decoder, say -- has nowhere
// to put it in the browser. Upstream flowgraphs end such a chain in a File Sink
// and read the file afterwards; here the filesystem is Emscripten's in-memory one
// and nothing can open it. What the browser does have is the console pane, which
// runner.html feeds from stdout, so this block writes there instead.
//
// Output is line-oriented because that is how Emscripten's print hook works: it
// accumulates characters and only calls out to JS on a newline. So a partial line
// is held back rather than shown, which is why max_line exists -- a PSK31 QSO can
// run for a paragraph before it sends one.
#pragma once

#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>
#include <gnuradio/sync_block.h>

#include <cstdint>
#include <iostream>
#include <string>
#include <utility>

class TextSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<TextSinkWasm>;

    static sptr make(std::string prefix, int max_line)
    {
        return gnuradio::make_block_sptr<TextSinkWasm>(std::move(prefix), max_line);
    }

    TextSinkWasm(std::string prefix, int max_line)
        : gr::sync_block("text_sink",
                         gr::io_signature::make(1, 1, sizeof(char)),
                         gr::io_signature::make(0, 0, 0)),
          d_prefix(std::move(prefix)),
          d_max_line(max_line > 0 ? max_line : kDefaultMaxLine)
    {
    }

    // Flush whatever the stream ended mid-line with, so the tail of a decode is
    // not swallowed when the flowgraph stops.
    bool stop() override
    {
        flush_line();
        return true;
    }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& /*output_items*/) override
    {
        const auto* in = static_cast<const std::uint8_t*>(input_items[0]);
        for (int i = 0; i < noutput_items; i++) {
            const std::uint8_t byte = in[i];
            if (byte == '\n' || byte == '\r') {
                // CR, LF and CRLF all end one line and no more than one: PSK31
                // operators send all three.
                if (!(byte == '\n' && d_last_was_cr))
                    flush_line();
                d_last_was_cr = (byte == '\r');
                continue;
            }
            d_last_was_cr = false;
            // Anything unprintable stands in as '.', which keeps a decode error
            // visible as a character rather than as a hole or a control code.
            d_line += (byte == '\t' || (byte >= 0x20 && byte < 0x7f))
                          ? static_cast<char>(byte)
                          : '.';
            if (static_cast<int>(d_line.size()) >= d_max_line)
                flush_line();
        }
        return noutput_items;
    }

private:
    static constexpr int kDefaultMaxLine = 72;

    // Not emit(): registry.cpp includes Qt, whose `emit` macro expands to
    // nothing, so a method by that name compiles to `();`.
    void flush_line()
    {
        if (d_line.empty())
            return;
        std::cout << d_prefix << d_line << '\n' << std::flush;
        d_line.clear();
    }

    const std::string d_prefix;
    const int d_max_line;
    std::string d_line;
    bool d_last_was_cr = false;
};
