// Browser helper for gr-bbc's frequency-hop example.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>
#include <pmt/pmt.h>

#include <cerrno>
#include <cstdlib>
#include <string>

class BbcFrequencyCommand : public gr::block
{
public:
    using sptr = std::shared_ptr<BbcFrequencyCommand>;

    static sptr make() { return gnuradio::make_block_sptr<BbcFrequencyCommand>(); }

    BbcFrequencyCommand()
        : gr::block("BBC Frequency Command",
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0))
    {
        const auto decoded = pmt::mp("decoded");
        message_port_register_in(decoded);
        message_port_register_out(pmt::mp("freq"));
        set_msg_handler(decoded, [this](const pmt::pmt_t& message) { handle(message); });
    }

private:
    void handle(const pmt::pmt_t& message)
    {
        if (!pmt::is_pair(message) || !pmt::is_u8vector(pmt::cdr(message)))
            return;
        std::size_t length = 0;
        const auto* bytes = pmt::u8vector_elements(pmt::cdr(message), length);
        std::string text(reinterpret_cast<const char*>(bytes), length);
        if (const auto nul = text.find('\0'); nul != std::string::npos)
            text.resize(nul);
        const auto first = text.find_first_not_of(" \t\r\n");
        if (first == std::string::npos)
            return;
        const auto last = text.find_last_not_of(" \t\r\n");
        text = text.substr(first, last - first + 1);
        char* end = nullptr;
        errno = 0;
        const double value = std::strtod(text.c_str(), &end);
        if (errno || end != text.c_str() + text.size())
            return;
        message_port_pub(pmt::mp("freq"),
                         pmt::cons(pmt::mp("freq"), pmt::from_double(value)));
    }
};
