#pragma once

#include "registry.hpp"

#include <gnuradio/gr_complex.h>
#include <pmt/pmt.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <initializer_list>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace wasm_registry {

inline std::string strip_quotes(std::string value)
{
    if (value.size() >= 2 &&
        ((value.front() == '\'' && value.back() == '\'') ||
         (value.front() == '"' && value.back() == '"')))
        return value.substr(1, value.size() - 2);
    return value;
}

inline std::string text(const nlohmann::json& params,
                        const char* key,
                        std::string fallback = {})
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return fallback;
    if (item->is_string())
        return strip_quotes(item->get<std::string>());
    return item->dump();
}

inline bool boolean(const nlohmann::json& params, const char* key, bool fallback)
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return fallback;
    if (item->is_boolean())
        return item->get<bool>();
    if (item->is_number())
        return item->get<double>() != 0.0;
    std::string value = text(params, key);
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (value == "true" || value == "yes" || value == "on" || value == "1")
        return true;
    if (value == "false" || value == "no" || value == "off" || value == "0")
        return false;
    throw std::runtime_error(std::string(key) + " must be boolean");
}

template <typename T>
T number(const nlohmann::json& params, const char* key, T fallback)
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return fallback;
    if (item->is_number())
        return static_cast<T>(item->get<double>());
    if (!item->is_string())
        throw std::runtime_error(std::string(key) + " must be numeric");
    std::string value = strip_quotes(item->get<std::string>());
    std::size_t used = 0;
    if constexpr (std::is_integral_v<T>) {
        const auto parsed = std::stoll(value, &used, 0);
        if (used == value.size())
            return static_cast<T>(parsed);
    } else {
        const auto parsed = std::stold(value, &used);
        if (used == value.size())
            return static_cast<T>(parsed);
    }
    throw std::runtime_error(std::string(key) + " must be numeric");
}

inline gr_complex complex(const nlohmann::json& params,
                          const char* key,
                          gr_complex fallback = {})
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return fallback;
    if (item->is_number())
        return { item->get<float>(), 0.0F };
    if (item->is_array() && item->size() == 2)
        return { (*item)[0].get<float>(), (*item)[1].get<float>() };

    std::string value = text(params, key);
    value.erase(std::remove_if(value.begin(), value.end(), [](unsigned char c) {
                    return std::isspace(c);
                }),
                value.end());
    std::replace(value.begin(), value.end(), 'j', 'i');
    if (value.empty())
        throw std::runtime_error(std::string(key) + " must be complex");
    if (value.back() != 'i')
        return { std::stof(value), 0.0F };
    value.pop_back();
    std::size_t split = std::string::npos;
    for (std::size_t i = 1; i < value.size(); ++i) {
        if ((value[i] == '+' || value[i] == '-') && value[i - 1] != 'e' &&
            value[i - 1] != 'E')
            split = i;
    }
    const std::string real = split == std::string::npos ? "0" : value.substr(0, split);
    std::string imag = split == std::string::npos ? value : value.substr(split);
    if (imag.empty() || imag == "+")
        imag = "1";
    if (imag == "-")
        imag = "-1";
    return { std::stof(real), std::stof(imag) };
}

template <typename T>
std::vector<T> vector(const nlohmann::json& params,
                      const char* key,
                      std::vector<T> fallback = {})
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return fallback;
    nlohmann::json values = *item;
    if (item->is_string()) {
        std::string source = strip_quotes(item->get<std::string>());
        source.erase(std::remove_if(source.begin(), source.end(), [](unsigned char c) {
                         return std::isspace(c);
                     }),
                     source.end());
        if (source == "()" || source == "(,)" || source == "[]")
            return {};
        std::replace(source.begin(), source.end(), '(', '[');
        std::replace(source.begin(), source.end(), ')', ']');
        try {
            values = nlohmann::json::parse(source);
        } catch (const std::exception&) {
            throw std::runtime_error(std::string(key) + " must be a JSON-style vector");
        }
    }
    if (!values.is_array())
        throw std::runtime_error(std::string(key) + " must be a vector");
    std::vector<T> result;
    result.reserve(values.size());
    for (const auto& value : values) {
        if constexpr (std::is_same_v<T, gr_complex> || std::is_same_v<T, gr_complexd>) {
            if (value.is_number())
                result.emplace_back(value.get<float>(), 0.0F);
            else if (value.is_array() && value.size() == 2)
                result.emplace_back(value[0].get<float>(), value[1].get<float>());
            else
                throw std::runtime_error(std::string(key) + " has an invalid complex item");
        } else {
            result.push_back(value.get<T>());
        }
    }
    return result;
}

inline std::vector<int> cp_lengths(const nlohmann::json& params,
                                   const char* key,
                                   int input_size)
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return { input_size / 4 };
    if (item->is_array())
        return vector<int>(params, key);
    if (item->is_number())
        return { static_cast<int>(item->get<double>()) };
    const std::string value = text(params, key);
    if (value == "fft_len/4" || value == "input_size/4")
        return { input_size / 4 };
    try {
        return { number<int>(params, key, input_size / 4) };
    } catch (const std::exception&) {
        return vector<int>(params, key);
    }
}

template <typename T>
T choice(const nlohmann::json& params,
         const char* key,
         std::initializer_list<std::pair<const char*, T>> choices,
         T fallback)
{
    const std::string value = text(params, key);
    if (value.empty())
        return fallback;
    for (const auto& option : choices) {
        if (value == option.first)
            return option.second;
    }
    throw std::runtime_error(std::string(key) + " has unsupported value '" + value + "'");
}

inline pmt::pmt_t pmt_value(const nlohmann::json& params,
                            const char* key,
                            pmt::pmt_t fallback = pmt::PMT_NIL)
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return fallback;
    if (item->is_boolean())
        return pmt::from_bool(item->get<bool>());
    if (item->is_number_integer())
        return pmt::from_long(item->get<long>());
    if (item->is_number())
        return pmt::from_double(item->get<double>());
    const std::string value = text(params, key);
    if (value.empty() || value == "None" || value == "pmt.PMT_NIL" ||
        value == "pmt::PMT_NIL")
        return pmt::PMT_NIL;
    return pmt::intern(value);
}

inline unsigned int throttle_limit(const nlohmann::json& params,
                                   double maximum,
                                   double sample_rate)
{
    const std::string limit = text(params, "limit", "auto");
    if (limit == "time")
        return std::max(static_cast<unsigned int>(maximum * sample_rate), 1U);
    if (limit == "items")
        return std::max(static_cast<unsigned int>(maximum), 1U);
    return 0;
}

} // namespace wasm_registry
