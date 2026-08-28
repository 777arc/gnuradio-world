// Parameter decoding for the vendored out-of-tree module gr-ieee802-15-4.
//
// Most block arguments are handled directly by the generated registry. The
// exceptions are RIME's uint16_t/uint8_t vectors, which GRC exposes as ordinary
// int vectors. Keeping these conversions here leaves the upstream submodule
// pristine.
#pragma once

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace wasm_ieee802_15_4 {

template <typename T>
std::vector<T> narrow_vector(const std::vector<int>& values, const char* label)
{
    static_assert(std::is_unsigned_v<T>);
    std::vector<T> result;
    result.reserve(values.size());
    for (const int value : values) {
        if (value < 0 ||
            static_cast<unsigned long long>(value) >
                static_cast<unsigned long long>(std::numeric_limits<T>::max())) {
            throw std::runtime_error(std::string(label) + " value out of range: " +
                                     std::to_string(value));
        }
        result.push_back(static_cast<T>(value));
    }
    return result;
}

inline std::vector<std::uint16_t> channels(const std::vector<int>& values)
{
    return narrow_vector<std::uint16_t>(values, "RIME channel");
}

inline std::vector<std::uint8_t> address(const std::vector<int>& values)
{
    if (values.size() != 2)
        throw std::runtime_error("RIME address must contain exactly two octets");
    return narrow_vector<std::uint8_t>(values, "RIME address");
}

} // namespace wasm_ieee802_15_4
