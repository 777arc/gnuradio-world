// Parameter decoding for the vendored out-of-tree module gr-ieee802-11.
//
// Three of its GRC parameters do not reach the C++ make() in the shape the
// factory generator can produce on its own, and all three are fixed here rather
// than in the submodule's yaml so the checkout stays pinned to pristine upstream:
//
//   * frame_equalizer's `algo` and mapper's `encoding` are `dtype: raw` holding
//     a Python enum constant (`ieee802_11.LS`, `ieee802_11.BPSK_1_2`).  The
//     generator cannot type a bare `raw`, so metadata.yml retypes both to
//     `string` and the make template maps the text to the enumerator here.
//     Keeping the *text* means a .grc still spells the value exactly as
//     upstream's own example flowgraphs do.
//   * mac's three address parameters are `int_vector` in GRC -- which is what
//     makes the editor evaluate `[0x23] * 6` before the runner sees it -- while
//     mac::make() takes std::vector<uint8_t>.
//
// These take plain C++ arguments, never a `const json&`, which is what keeps
// them on this side of the registry.cpp line (see AGENTS.md, "Registry and
// module conventions").
#pragma once

#include <cstdint>
#include <ieee802_11/frame_equalizer.h>
#include <ieee802_11/mac.h>
#include <ieee802_11/mapper.h>
#include <stdexcept>
#include <string>
#include <vector>

namespace wasm_ieee802_11 {

// `ieee802_11.LS`, `ieee802_11::LS` and a bare `LS` all name one enumerator, and
// a .grc may carry any of the three: the editor passes a non-numeric parameter
// through verbatim, so whichever spelling the author wrote is what arrives.
// Match on the trailing identifier, as wasm_registry::choice() does for enums.
inline std::string enumerator(const std::string& value)
{
    const auto pos = value.find_last_of(".:");
    return pos == std::string::npos ? value : value.substr(pos + 1);
}

// An absent parameter already arrived as the metadata default, so an empty
// string here means the .grc named nothing at all; take the upstream default
// rather than failing the flowgraph over it.  An unrecognised name is a typo and
// does fail, where GR's logger turns it into a RUNNER_FAIL naming the value.
inline gr::ieee802_11::Equalizer equalizer(const std::string& value)
{
    const std::string name = enumerator(value);
    if (name.empty() || name == "LS")
        return gr::ieee802_11::LS;
    if (name == "LMS")
        return gr::ieee802_11::LMS;
    if (name == "COMB")
        return gr::ieee802_11::COMB;
    if (name == "STA")
        return gr::ieee802_11::STA;
    throw std::runtime_error("unknown frame equalizer algorithm: " + value);
}

inline gr::ieee802_11::Encoding encoding(const std::string& value)
{
    const std::string name = enumerator(value);
    if (name.empty() || name == "BPSK_1_2")
        return gr::ieee802_11::BPSK_1_2;
    if (name == "BPSK_3_4")
        return gr::ieee802_11::BPSK_3_4;
    if (name == "QPSK_1_2")
        return gr::ieee802_11::QPSK_1_2;
    if (name == "QPSK_3_4")
        return gr::ieee802_11::QPSK_3_4;
    if (name == "QAM16_1_2")
        return gr::ieee802_11::QAM16_1_2;
    if (name == "QAM16_3_4")
        return gr::ieee802_11::QAM16_3_4;
    if (name == "QAM64_2_3")
        return gr::ieee802_11::QAM64_2_3;
    if (name == "QAM64_3_4")
        return gr::ieee802_11::QAM64_3_4;
    throw std::runtime_error("unknown WiFi encoding: " + value);
}

// The same six-octet check the block's GRC `asserts` make, restated because the
// runner does not evaluate asserts: without it a short address would leave
// mac.cc reading past the end of the vector it copies into the frame header.
inline std::vector<std::uint8_t> mac_address(const std::vector<int>& octets)
{
    if (octets.size() != 6)
        throw std::runtime_error("a MAC address needs exactly 6 octets, got " +
                                 std::to_string(octets.size()));
    std::vector<std::uint8_t> address;
    address.reserve(octets.size());
    for (int octet : octets) {
        if (octet < 0 || octet > 255)
            throw std::runtime_error("MAC address octet out of range: " +
                                     std::to_string(octet));
        address.push_back(static_cast<std::uint8_t>(octet));
    }
    return address;
}

} // namespace wasm_ieee802_11
