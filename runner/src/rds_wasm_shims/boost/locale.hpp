#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <type_traits>

// gr-rds uses Boost.Locale only to convert RDS RadioText from ISO-8859-2 to
// UTF-8. Boost.Locale is not part of the WASM sysroot, so provide that narrow
// API inline for the browser build.
namespace boost::locale::conv {

template <typename CharOut>
std::basic_string<CharOut> to_utf(const std::string& input,
                                  const std::string& charset)
{
    static_assert(std::is_same_v<CharOut, char>,
                  "the gr-rds WASM shim only supports UTF-8 output");
    if (charset != "ISO-8859-2")
        throw std::invalid_argument("unsupported gr-rds input charset: " + charset);

    static constexpr std::uint16_t high[96] = {
        0x00A0, 0x0104, 0x02D8, 0x0141, 0x00A4, 0x013D, 0x015A, 0x00A7,
        0x00A8, 0x0160, 0x015E, 0x0164, 0x0179, 0x00AD, 0x017D, 0x017B,
        0x00B0, 0x0105, 0x02DB, 0x0142, 0x00B4, 0x013E, 0x015B, 0x02C7,
        0x00B8, 0x0161, 0x015F, 0x0165, 0x017A, 0x02DD, 0x017E, 0x017C,
        0x0154, 0x00C1, 0x00C2, 0x0102, 0x00C4, 0x0139, 0x0106, 0x00C7,
        0x010C, 0x00C9, 0x0118, 0x00CB, 0x011A, 0x00CD, 0x00CE, 0x010E,
        0x0110, 0x0143, 0x0147, 0x00D3, 0x00D4, 0x0150, 0x00D6, 0x00D7,
        0x0158, 0x016E, 0x00DA, 0x0170, 0x00DC, 0x00DD, 0x0162, 0x00DF,
        0x0155, 0x00E1, 0x00E2, 0x0103, 0x00E4, 0x013A, 0x0107, 0x00E7,
        0x010D, 0x00E9, 0x0119, 0x00EB, 0x011B, 0x00ED, 0x00EE, 0x010F,
        0x0111, 0x0144, 0x0148, 0x00F3, 0x00F4, 0x0151, 0x00F6, 0x00F7,
        0x0159, 0x016F, 0x00FA, 0x0171, 0x00FC, 0x00FD, 0x0163, 0x02D9,
    };

    std::string output;
    output.reserve(input.size());
    for (const unsigned char byte : input) {
        const std::uint32_t codepoint =
            byte < 0xA0 ? byte : high[byte - 0xA0];
        if (codepoint < 0x80) {
            output.push_back(static_cast<char>(codepoint));
        } else if (codepoint < 0x800) {
            output.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
            output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else {
            output.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
            output.push_back(
                static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        }
    }
    return output;
}

} // namespace boost::locale::conv
