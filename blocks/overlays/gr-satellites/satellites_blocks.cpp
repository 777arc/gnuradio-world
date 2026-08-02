// Browser-native ports of gr-satellites Python utility blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "satellites_blocks.hpp"

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <pmt/pmt.h>
#include <satellites/crc.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <ctime>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wasm_satellites {
namespace {

class MessageBlock : public gr::block
{
public:
    using Handler = std::function<void(MessageBlock&, const pmt::pmt_t&)>;

    MessageBlock(std::string name, std::vector<std::string> outputs, Handler handler)
        : gr::block(std::move(name),
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0)),
          d_handler(std::move(handler))
    {
        message_port_register_in(pmt::mp("in"));
        for (const auto& output : outputs)
            message_port_register_out(pmt::mp(output));
        set_msg_handler(pmt::mp("in"),
                        [this](const pmt::pmt_t& message) { d_handler(*this, message); });
    }

    void publish(const char* port, const pmt::pmt_t& message)
    {
        message_port_pub(pmt::mp(port), message);
    }

private:
    Handler d_handler;
};

gr::basic_block_sptr make_message_block(const char* name,
                                        std::initializer_list<const char*> outputs,
                                        MessageBlock::Handler handler)
{
    std::vector<std::string> output_names;
    output_names.reserve(outputs.size());
    for (const char* output : outputs)
        output_names.emplace_back(output);
    return gnuradio::make_block_sptr<MessageBlock>(
        name, std::move(output_names), std::move(handler));
}

bool unpack_u8_pdu(const pmt::pmt_t& message,
                   pmt::pmt_t& metadata,
                   std::vector<std::uint8_t>& data)
{
    if (!pmt::is_pair(message) || !pmt::is_u8vector(pmt::cdr(message))) {
        std::cerr << "[gr-satellites] expected a u8vector PDU\n";
        return false;
    }
    metadata = pmt::car(message);
    data = pmt::u8vector_elements(pmt::cdr(message));
    return true;
}

pmt::pmt_t make_u8_pdu(const pmt::pmt_t& metadata,
                       const std::vector<std::uint8_t>& data)
{
    return pmt::cons(metadata, pmt::init_u8vector(data.size(), data));
}

std::uint8_t reverse_bits(std::uint8_t value)
{
    value = static_cast<std::uint8_t>((value >> 4) | (value << 4));
    value = static_cast<std::uint8_t>(((value & 0xCCU) >> 2) |
                                      ((value & 0x33U) << 2));
    return static_cast<std::uint8_t>(((value & 0xAAU) >> 1) |
                                     ((value & 0x55U) << 1));
}

std::vector<std::uint8_t> parse_hex(const std::string& source)
{
    std::string compact;
    compact.reserve(source.size());
    for (const unsigned char c : source) {
        if (!std::isspace(c))
            compact.push_back(static_cast<char>(c));
    }
    if (compact.size() % 2 != 0)
        throw std::runtime_error("hex string must contain complete bytes");

    auto digit = [](char c) -> unsigned {
        if (c >= '0' && c <= '9')
            return static_cast<unsigned>(c - '0');
        if (c >= 'a' && c <= 'f')
            return static_cast<unsigned>(c - 'a' + 10);
        if (c >= 'A' && c <= 'F')
            return static_cast<unsigned>(c - 'A' + 10);
        throw std::runtime_error("hex string contains a non-hexadecimal character");
    };

    std::vector<std::uint8_t> result;
    result.reserve(compact.size() / 2);
    for (std::size_t i = 0; i < compact.size(); i += 2)
        result.push_back(static_cast<std::uint8_t>(
            (digit(compact[i]) << 4) | digit(compact[i + 1])));
    return result;
}

bool hdlc_fcs_ok(const std::vector<std::uint8_t>& frame)
{
    if (frame.size() <= 2)
        return false;
    gr::satellites::crc calculator(16, 0x1021, 0xFFFF, 0xFFFF, true, true);
    const auto expected = calculator.compute(frame.data(), frame.size() - 2);
    return frame[frame.size() - 2] == (expected & 0xFFU) &&
           frame.back() == ((expected >> 8) & 0xFFU);
}

bool contains(const std::vector<int>& values, int value)
{
    return std::find(values.begin(), values.end(), value) != values.end();
}

} // namespace

gr::basic_block_sptr make_aausat4_check_fsm()
{
    return make_message_block(
        "aausat4_remove_fsm", { "short", "long" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            if (!pmt::is_pair(message) || !pmt::is_f32vector(pmt::cdr(message))) {
                std::cerr << "[aausat4_remove_fsm] expected an f32vector PDU\n";
                return;
            }
            const auto samples = pmt::f32vector_elements(pmt::cdr(message));
            const auto publish_slice = [&](const char* port, std::size_t count) {
                const std::size_t begin = std::min<std::size_t>(8, samples.size());
                const std::size_t end = std::min(samples.size(), begin + count);
                std::vector<float> output(samples.begin() + begin, samples.begin() + end);
                block.publish(
                    port,
                    pmt::cons(pmt::PMT_NIL,
                              pmt::init_f32vector(output.size(), output)));
            };
            publish_slice("short", 1020);
            publish_slice("long", 1996);
        });
}

gr::basic_block_sptr make_beesat_classifier()
{
    return make_message_block(
        "beesat_classifier",
        { "BEESAT-1", "BEESAT-2", "BEESAT-4", "BEESAT-9", "TECHNOSAT" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 10)
                return;
            const std::string callsign(packet.begin() + 2, packet.begin() + 8);
            const char* port = nullptr;
            if (callsign == "DP0BEE")
                port = "BEESAT-1";
            else if (callsign == "DP0BEF")
                port = "BEESAT-2";
            else if (callsign == "DP0BEH")
                port = "BEESAT-4";
            else if (callsign == "DP0BEM")
                port = "BEESAT-9";
            else if (callsign == "DP0TBA")
                port = "TECHNOSAT";
            if (port)
                block.publish(port, message);
        });
}

gr::basic_block_sptr make_cc11xx_packet_crop(bool use_crc16)
{
    return make_message_block(
        "cc11xx_packet_crop", { "out" },
        [use_crc16](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.empty())
                return;
            const std::size_t length =
                static_cast<std::size_t>(packet[0]) + 1 + (use_crc16 ? 2 : 0);
            if (length > packet.size())
                return;
            packet.resize(length);
            block.publish("out", make_u8_pdu(metadata, packet));
        });
}

gr::basic_block_sptr make_check_address(const std::string& address,
                                        const std::string& direction,
                                        const std::string& digicallsign)
{
    const auto separator = address.rfind('-');
    const std::string callsign =
        separator == std::string::npos ? address : address.substr(0, separator);
    int ssid = -1;
    if (separator != std::string::npos)
        ssid = std::stoi(address.substr(separator + 1));

    return make_message_block(
        "check_address", { "ok", "fail" },
        [callsign, ssid, direction, digicallsign](
            MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet))
                return;
            if (packet.size() < 16) {
                block.publish("fail", message);
                return;
            }

            const std::size_t address_offset = direction == "to" ? 0 : 7;
            std::string packet_callsign;
            packet_callsign.reserve(6);
            for (std::size_t i = 0; i < 6; ++i)
                packet_callsign.push_back(
                    static_cast<char>(packet[address_offset + i] >> 1));
            while (!packet_callsign.empty() && packet_callsign.back() == ' ')
                packet_callsign.pop_back();
            const int packet_ssid = (packet[address_offset + 6] >> 1) & 0x0F;

            bool digi_match = false;
            if (packet.size() > 20 && (packet[13] & 1U) == 0 &&
                (packet[20] >> 7) == 1) {
                std::string digi;
                digi.reserve(6);
                for (std::size_t i = 14; i < 20; ++i)
                    digi.push_back(static_cast<char>(packet[i] >> 1));
                while (!digi.empty() && digi.back() == ' ')
                    digi.pop_back();
                digi_match = digi == digicallsign;
            }
            const bool address_match =
                packet_callsign == callsign && (ssid < 0 || packet_ssid == ssid);
            block.publish(address_match || digi_match ? "ok" : "fail", message);
        });
}

gr::basic_block_sptr make_check_astrocast_crc(bool verbose)
{
    return make_message_block(
        "check_astrocast_crc", { "ok", "fail" },
        [verbose](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 2)
                return;
            packet.erase(packet.begin());
            const auto flag = std::find(packet.begin(), packet.end(), 0x7E);
            if (flag == packet.end())
                return;
            const std::vector<std::uint8_t> frame(packet.begin(), flag);
            if (frame.size() < 2)
                return;
            std::vector<std::uint8_t> output(frame.begin(), frame.end() - 2);
            const bool okay = hdlc_fcs_ok(frame);
            if (verbose)
                std::cout << (okay ? "CRC OK\n" : "CRC failed\n");
            block.publish(okay ? "ok" : "fail", make_u8_pdu(metadata, output));
        });
}

gr::basic_block_sptr make_check_hex_string(const std::string& hex_string,
                                           int start_index)
{
    const auto expected = parse_hex(hex_string);
    if (start_index < 0)
        throw std::runtime_error("start index must be non-negative");
    return make_message_block(
        "check_hex_string", { "ok", "fail" },
        [expected, start_index](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet))
                return;
            const auto begin = static_cast<std::size_t>(start_index);
            const bool match =
                begin <= packet.size() && expected.size() <= packet.size() - begin &&
                std::equal(expected.begin(), expected.end(), packet.begin() + begin);
            block.publish(match ? "ok" : "fail", message);
        });
}

gr::basic_block_sptr make_csp_address_filter(
    const std::vector<int>& allowed_sources,
    const std::vector<int>& allowed_destinations)
{
    return make_message_block(
        "csp_address_filter", { "out" },
        [allowed_sources, allowed_destinations](
            MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 4)
                return;
            const int source = (packet[0] >> 1) & 0x1F;
            const int destination = ((packet[0] & 1) << 4) | (packet[1] >> 4);
            if (contains(allowed_sources, source) &&
                contains(allowed_destinations, destination))
                block.publish("out", message);
        });
}

gr::basic_block_sptr make_eseo_packet_crop(bool drop_rs)
{
    return make_message_block(
        "eseo_packet_crop", { "out" },
        [drop_rs](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet))
                return;
            const std::array<std::uint8_t, 2> marker{ 0x7E, 0x7E };
            const auto end =
                std::search(packet.begin(), packet.end(), marker.begin(), marker.end());
            if (end == packet.end())
                return;
            std::size_t crop = static_cast<std::size_t>(end - packet.begin());
            if (drop_rs) {
                if (crop < 16)
                    return;
                crop -= 16;
            }
            packet.resize(crop);
            std::transform(packet.begin(), packet.end(), packet.begin(), reverse_bits);
            block.publish("out", make_u8_pdu(metadata, packet));
        });
}

gr::basic_block_sptr make_hdlc_framer(int preamble_bytes, int postamble_bytes)
{
    if (preamble_bytes < 0 || postamble_bytes < 0)
        throw std::runtime_error("HDLC preamble and postamble must be non-negative");
    return make_message_block(
        "hdlc_framer", { "out" },
        [preamble_bytes, postamble_bytes](
            MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> data;
            if (!unpack_u8_pdu(message, metadata, data))
                return;
            gr::satellites::crc calculator(
                16, 0x1021, 0xFFFF, 0xFFFF, true, true);
            const auto checksum = calculator.compute(data);
            data.push_back(static_cast<std::uint8_t>(checksum & 0xFFU));
            data.push_back(static_cast<std::uint8_t>((checksum >> 8) & 0xFFU));

            constexpr std::array<std::uint8_t, 8> flag{
                0, 1, 1, 1, 1, 1, 1, 0
            };
            std::vector<std::uint8_t> output;
            output.reserve(static_cast<std::size_t>(
                (preamble_bytes + postamble_bytes) * 8 + data.size() * 10));
            for (int i = 0; i < preamble_bytes; ++i)
                output.insert(output.end(), flag.begin(), flag.end());
            int ones = 0;
            for (std::uint8_t byte : data) {
                for (int bit = 0; bit < 8; ++bit) {
                    const auto value = static_cast<std::uint8_t>((byte >> bit) & 1U);
                    output.push_back(value);
                    if (value)
                        ++ones;
                    else
                        ones = 0;
                    if (ones == 5) {
                        output.push_back(0);
                        ones = 0;
                    }
                }
            }
            for (int i = 0; i < postamble_bytes; ++i)
                output.insert(output.end(), flag.begin(), flag.end());
            block.publish("out", make_u8_pdu(metadata, output));
        });
}

gr::basic_block_sptr make_ks1q_header_remover(bool verbose)
{
    return make_message_block(
        "ks1q_header_remover", { "out" },
        [verbose](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() <= 3)
                return;
            if (verbose) {
                std::cout << "Spacecraft ID " << std::hex << std::setfill('0')
                          << std::setw(2) << static_cast<int>(packet[0])
                          << std::setw(2) << static_cast<int>(packet[1])
                          << std::dec << '\n';
                std::cout << (packet[2] == 0x50
                                  ? "CSP downlink, protocol version 0\n"
                                  : "Unknown packet type\n");
            }
            packet.erase(packet.begin(), packet.begin() + 3);
            block.publish("out", make_u8_pdu(pmt::PMT_NIL, packet));
        });
}

gr::basic_block_sptr make_ngham_packet_crop()
{
    static constexpr std::array<std::uint32_t, 7> tags{
        0x3B49CD, 0x4DDA57, 0x76939A, 0x9BB4AE, 0xA0FD63, 0xD66EF9, 0xED2734
    };
    static constexpr std::array<std::size_t, 7> sizes{
        47, 79, 111, 159, 191, 223, 255
    };
    return make_message_block(
        "ngham_packet_crop", { "rs16", "rs32" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 3)
                return;
            const std::uint32_t received =
                (static_cast<std::uint32_t>(packet[0]) << 16) |
                (static_cast<std::uint32_t>(packet[1]) << 8) | packet[2];
            unsigned best_distance = std::numeric_limits<unsigned>::max();
            std::size_t best = 0;
            for (std::size_t i = 0; i < tags.size(); ++i) {
                std::uint32_t difference = received ^ tags[i];
                unsigned distance = 0;
                while (difference) {
                    difference &= difference - 1;
                    ++distance;
                }
                if (distance < best_distance) {
                    best_distance = distance;
                    best = i;
                }
            }
            if (packet.size() - 3 < sizes[best])
                return;
            std::vector<std::uint8_t> output(
                packet.begin() + 3, packet.begin() + 3 + sizes[best]);
            block.publish(best < 3 ? "rs16" : "rs32",
                          make_u8_pdu(metadata, output));
        });
}

gr::basic_block_sptr make_ngham_remove_padding()
{
    static constexpr std::array<std::size_t, 7> rs_sizes{
        47, 79, 111, 159, 191, 223, 255
    };
    static constexpr std::array<std::size_t, 7> data_sizes{
        31, 63, 95, 127, 159, 191, 223
    };
    return make_message_block(
        "ngham_remove_padding", { "out" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.empty())
                return;
            const auto rs = std::find(rs_sizes.begin(), rs_sizes.end(), packet.size());
            if (rs != rs_sizes.end())
                packet.resize(data_sizes[static_cast<std::size_t>(rs - rs_sizes.begin())]);
            if (std::find(data_sizes.begin(), data_sizes.end(), packet.size()) ==
                data_sizes.end())
                return;
            const std::size_t padding = packet[0] & 0x1FU;
            if (padding > packet.size())
                return;
            if (padding != 0)
                packet.resize(packet.size() - padding);
            block.publish("out", make_u8_pdu(metadata, packet));
        });
}

gr::basic_block_sptr make_print_header()
{
    return make_message_block(
        "print_header", {},
        [](MessageBlock&, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 4) {
                std::cerr << "Malformed CSP packet (too short)\n";
                return;
            }
            const std::uint32_t header =
                (static_cast<std::uint32_t>(packet[0]) << 24) |
                (static_cast<std::uint32_t>(packet[1]) << 16) |
                (static_cast<std::uint32_t>(packet[2]) << 8) | packet[3];
            std::cout << "CSP header:\n"
                      << "  Priority: " << ((header >> 30) & 0x3) << '\n'
                      << "  Source: " << ((header >> 25) & 0x1F) << '\n'
                      << "  Destination: " << ((header >> 20) & 0x1F) << '\n'
                      << "  Destination port: " << ((header >> 14) & 0x3F) << '\n'
                      << "  Source port: " << ((header >> 8) & 0x3F) << '\n'
                      << "  Reserved: " << ((header >> 4) & 0xF) << '\n'
                      << "  HMAC: " << ((header >> 3) & 1) << '\n'
                      << "  XTEA: " << ((header >> 2) & 1) << '\n'
                      << "  RDP: " << ((header >> 1) & 1) << '\n'
                      << "  CRC: " << (header & 1) << '\n';
        });
}

gr::basic_block_sptr make_print_timestamp(const std::string& format,
                                          bool count_packets)
{
    auto counter = std::make_shared<std::uint64_t>(0);
    return make_message_block(
        "print_timestamp", { "out" },
        [format, count_packets, counter](
            MessageBlock& block, const pmt::pmt_t& message) {
            if (!format.empty()) {
                const auto now = std::chrono::system_clock::now();
                const std::time_t time = std::chrono::system_clock::to_time_t(now);
                if (const std::tm* utc = std::gmtime(&time)) {
                    std::array<char, 256> buffer{};
                    if (std::strftime(buffer.data(), buffer.size(), format.c_str(), utc))
                        std::cout << buffer.data() << '\n';
                }
            }
            if (count_packets)
                std::cout << "Packet number " << (*counter)++ << '\n';
            block.publish("out", message);
        });
}

gr::basic_block_sptr make_reflect_bytes()
{
    return make_message_block(
        "reflect_bytes", { "out" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet))
                return;
            std::transform(packet.begin(), packet.end(), packet.begin(), reverse_bits);
            block.publish("out", make_u8_pdu(pmt::PMT_NIL, packet));
        });
}

gr::basic_block_sptr make_snet_classifier()
{
    return make_message_block(
        "snet_classifier", { "SNET-A", "SNET-B", "SNET-C", "SNET-D" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            if (!pmt::is_pair(message))
                return;
            const auto source = pmt::dict_ref(
                pmt::car(message), pmt::intern("SNET SrcId"), pmt::PMT_NIL);
            if (pmt::eq(source, pmt::PMT_NIL) || !pmt::is_integer(source))
                return;
            const long satellite = pmt::to_long(source) >> 1;
            static constexpr std::array<const char*, 4> ports{
                "SNET-A", "SNET-B", "SNET-C", "SNET-D"
            };
            if (satellite >= 0 && satellite < static_cast<long>(ports.size()))
                block.publish(ports[static_cast<std::size_t>(satellite)], message);
        });
}

gr::basic_block_sptr make_swap_crc()
{
    return make_message_block(
        "swap_crc", { "out" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 4)
                return;
            if ((packet[3] & 1U) == 0) {
                block.publish("out", message);
                return;
            }
            if (packet.size() < 8)
                return;
            std::reverse(packet.end() - 4, packet.end());
            block.publish("out", make_u8_pdu(pmt::PMT_NIL, packet));
        });
}

gr::basic_block_sptr make_swap_header()
{
    return make_message_block(
        "swap_header", { "out" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet))
                return;
            if (packet.size() >= 4)
                std::reverse(packet.begin(), packet.begin() + 4);
            else
                std::reverse(packet.begin(), packet.end());
            block.publish("out", make_u8_pdu(pmt::PMT_NIL, packet));
        });
}

gr::basic_block_sptr make_swiatowid_packet_crop()
{
    return make_message_block(
        "swiatowid_packet_crop", { "out" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() < 2)
                return;
            const int declared = packet[0] + packet[1] * 256 - 8;
            if (declared < 0 ||
                static_cast<std::size_t>(declared + 2) > packet.size())
                return;
            std::vector<std::uint8_t> output(
                packet.begin() + 2, packet.begin() + 2 + declared);
            block.publish("out", make_u8_pdu(metadata, output));
        });
}

gr::basic_block_sptr make_swiatowid_packet_split()
{
    return make_message_block(
        "swiatowid_packet_split", { "out" },
        [](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.size() <= 2)
                return;
            for (std::size_t offset = 0; offset < packet.size() - 2; offset += 58) {
                const auto end = std::min(packet.size(), offset + 58);
                std::vector<std::uint8_t> piece(
                    packet.begin() + offset, packet.begin() + end);
                block.publish("out", make_u8_pdu(metadata, piece));
            }
        });
}

gr::basic_block_sptr make_sx12xx_packet_crop(int crc_len)
{
    if (crc_len < 0)
        throw std::runtime_error("CRC length must be non-negative");
    return make_message_block(
        "sx12xx_packet_crop", { "out" },
        [crc_len](MessageBlock& block, const pmt::pmt_t& message) {
            pmt::pmt_t metadata;
            std::vector<std::uint8_t> packet;
            if (!unpack_u8_pdu(message, metadata, packet) || packet.empty())
                return;
            const std::size_t length =
                static_cast<std::size_t>(packet[0]) + 1 +
                static_cast<std::size_t>(crc_len);
            if (length > packet.size())
                return;
            packet.resize(length);
            block.publish("out", make_u8_pdu(metadata, packet));
        });
}

} // namespace wasm_satellites
