#pragma once

#include "registry.hpp"

#include <gnuradio/gr_complex.h>
#include <gnuradio/tags.h>
#include <pmt/pmt.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <initializer_list>
#include <map>
#include <memory>
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

template <typename State, typename Value, typename Apply>
void add_numeric_setter(BuiltBlock& built,
                        const std::string& parameter,
                        std::shared_ptr<State> state,
                        Value State::*field,
                        Apply apply)
{
    built.numeric_setters[parameter] =
        [state = std::move(state), field, apply = std::move(apply)](double value) {
            state.get()->*field = static_cast<Value>(value);
            apply();
        };
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

// Collapse C++ scope separators to the GRC/Python dotted spelling so enum option
// matching is insensitive to it. A block's cpp_templates `translations` (e.g.
// `analog\.cpm\.` -> `analog::cpm::`) are applied to the whole generated make
// string, which rewrites the choice() *match keys* into C++ form; the editor,
// however, sends the original dotted option value. Normalizing both sides here
// keeps them matching without special-casing each block.
inline std::string normalize_enum(std::string value)
{
    std::string::size_type pos = 0;
    while ((pos = value.find("::", pos)) != std::string::npos)
        value.replace(pos, 2, ".");
    return value;
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
    // Some yaml enums quote their option values ('"RS"', '"CCSDS"', ...), so the
    // generated match keys carry the quote characters while text() above has
    // already stripped them from the incoming value. Compare unquoted too.
    for (const auto& option : choices) {
        if (value == strip_quotes(option.first))
            return option.second;
    }
    const std::string normalized = normalize_enum(value);
    for (const auto& option : choices) {
        if (normalized == normalize_enum(strip_quotes(option.first)))
            return option.second;
    }
    // Last resort: compare only the trailing identifier. The generator renders
    // some enum option values with their namespace stripped (yaml's
    // `gr.GR_MSB_FIRST` becomes the match key `GR_MSB_FIRST`) while a .grc still
    // carries the fully qualified spelling. Enumerator names are unique within
    // one parameter, so matching on the tail cannot become ambiguous.
    auto tail = [](const std::string& s) {
        const auto pos = s.rfind('.');
        return pos == std::string::npos ? s : s.substr(pos + 1);
    };
    const std::string value_tail = tail(normalized);
    for (const auto& option : choices) {
        if (value_tail == tail(normalize_enum(strip_quotes(option.first))))
            return option.second;
    }
    throw std::runtime_error(std::string(key) + " has unsupported value '" + value + "'");
}

// --- PMT-valued parameters --------------------------------------------------
//
// Native GRC evaluates a PMT parameter as Python with `pmt` imported, so the
// values a .grc carries are constructor calls: `pmt.intern("TEST")`,
// `pmt.from_double(1.5)`, `pmt.cons(pmt.PMT_NIL, pmt.init_u8vector(3, [1,2,3]))`.
// There is no Python here, and the editor's expression evaluator deliberately
// stops at numbers and vectors (see EVALUATED_DTYPES in main.ts -- a `pmt` dtype
// is not in it), so the runner parses that constructor grammar itself. Anything
// that is *not* a call keeps the meaning a plain tag key already had: a bare or
// quoted word becomes a symbol, a number becomes a number.
//
// An unrecognized `pmt.<name>(...)` throws instead of being interned as its own
// source text. A Message Strobe emitting the literal symbol
// "pmt.init_f32vector(2, [1,2])" looks exactly like a working flowgraph until
// somebody reads the decoded output, which is the failure this whole file exists
// to avoid.
inline pmt::pmt_t pmt_from_expression(const std::string& expression);

namespace detail {

inline std::string trim(const std::string& value)
{
    const auto begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos)
        return {};
    return value.substr(begin, value.find_last_not_of(" \t\r\n") - begin + 1);
}

// Split an argument list at top-level commas only: those nested inside another
// call, a list literal or a string are part of an argument, not separators.
inline std::vector<std::string> pmt_arguments(const std::string& text)
{
    std::vector<std::string> arguments;
    std::string current;
    int depth = 0;
    char quote = '\0';
    for (const char c : text) {
        if (quote) {
            if (c == quote)
                quote = '\0';
        } else if (c == '"' || c == '\'') {
            quote = c;
        } else if (c == '(' || c == '[' || c == '{') {
            ++depth;
        } else if (c == ')' || c == ']' || c == '}') {
            --depth;
        } else if (c == ',' && depth == 0) {
            arguments.push_back(trim(current));
            current.clear();
            continue;
        }
        current.push_back(c);
    }
    const std::string last = trim(current);
    if (!last.empty() || !arguments.empty())
        arguments.push_back(last);
    return arguments;
}

inline void pmt_arity(const std::string& function,
                      const std::vector<std::string>& arguments,
                      std::size_t expected)
{
    if (arguments.size() != expected)
        throw std::runtime_error("pmt." + function + "() takes " +
                                 std::to_string(expected) + " argument(s), got " +
                                 std::to_string(arguments.size()));
}

inline double pmt_number(const std::string& function, const std::string& value)
{
    try {
        std::size_t used = 0;
        const double parsed = std::stod(value, &used);
        if (used == value.size())
            return parsed;
    } catch (const std::exception&) {
    }
    throw std::runtime_error("pmt." + function + "() expects a number, not '" +
                             value + "'");
}

inline bool pmt_boolean(const std::string& function, const std::string& value)
{
    if (value == "True" || value == "true" || value == "pmt.PMT_T")
        return true;
    if (value == "False" || value == "false" || value == "pmt.PMT_F")
        return false;
    throw std::runtime_error("pmt." + function + "() expects True or False, not '" +
                             value + "'");
}

// A uniform vector's items, from the literal list its second argument must be.
// `pmt.init_u8vector(len(data), data)` is legal Python and common upstream, but
// nothing here can resolve `data`, so the list has to be written out.
template <typename T>
std::vector<T> pmt_items(const std::string& function,
                         const std::vector<std::string>& arguments)
{
    pmt_arity(function, arguments, 2);
    nlohmann::json params;
    params["items"] = arguments[1];
    std::vector<T> items;
    try {
        items = wasm_registry::vector<T>(params, "items");
    } catch (const std::exception&) {
        throw std::runtime_error(
            "pmt." + function + "() needs a literal list of numbers, not '" +
            arguments[1] + "'");
    }
    const auto declared = static_cast<std::size_t>(pmt_number(function, arguments[0]));
    if (declared != items.size())
        throw std::runtime_error("pmt." + function + "() was given a length of " +
                                 std::to_string(declared) + " but " +
                                 std::to_string(items.size()) + " item(s)");
    return items;
}

// `k` has to be the real length: pmt's own vector overload reads `data[0..k)`
// and treats k == 0 as "empty", so passing anything else silently truncates.
template <typename T>
pmt::pmt_t pmt_vector(const std::string& function,
                      const std::vector<std::string>& arguments,
                      pmt::pmt_t (*init)(std::size_t, const std::vector<T>&))
{
    const auto items = pmt_items<T>(function, arguments);
    return init(items.size(), items);
}

}  // namespace detail

inline pmt::pmt_t pmt_from_expression(const std::string& expression)
{
    const std::string value = detail::trim(expression);
    if (value.empty() || value == "None" || value == "pmt.PMT_NIL" ||
        value == "pmt::PMT_NIL")
        return pmt::PMT_NIL;
    if (value == "True" || value == "pmt.PMT_T" || value == "pmt::PMT_T")
        return pmt::PMT_T;
    if (value == "False" || value == "pmt.PMT_F" || value == "pmt::PMT_F")
        return pmt::PMT_F;

    // Not a `pmt.` call: a quoted or bare word is a symbol (what a tag key
    // written as plain text has always meant here), a number is a number.
    const bool call = (value.rfind("pmt.", 0) == 0 || value.rfind("pmt::", 0) == 0) &&
                      value.back() == ')' && value.find('(') != std::string::npos;
    if (!call) {
        const std::string unquoted = strip_quotes(value);
        if (unquoted != value)
            return pmt::intern(unquoted);
        try {
            std::size_t used = 0;
            const double number = std::stod(value, &used);
            if (used == value.size()) {
                const bool integral = value.find_first_of(".eE") == std::string::npos;
                return integral ? pmt::from_long(static_cast<long>(number))
                                : pmt::from_double(number);
            }
        } catch (const std::exception&) {
        }
        return pmt::intern(value);
    }

    const auto open = value.find('(');
    const std::string prefix = value.rfind("pmt::", 0) == 0 ? "pmt::" : "pmt.";
    const std::string function = value.substr(prefix.size(), open - prefix.size());
    const auto arguments =
        detail::pmt_arguments(value.substr(open + 1, value.size() - open - 2));
    const auto argument = [&](std::size_t index) {
        return pmt_from_expression(arguments.at(index));
    };

    if (function == "intern" || function == "string_to_symbol") {
        detail::pmt_arity(function, arguments, 1);
        return pmt::intern(strip_quotes(arguments[0]));
    }
    if (function == "from_bool")
        return (detail::pmt_arity(function, arguments, 1),
                pmt::from_bool(detail::pmt_boolean(function, arguments[0])));
    if (function == "from_long" || function == "from_uint64") {
        detail::pmt_arity(function, arguments, 1);
        const auto number = detail::pmt_number(function, arguments[0]);
        return function == "from_long"
                   ? pmt::from_long(static_cast<long>(number))
                   : pmt::from_uint64(static_cast<std::uint64_t>(number));
    }
    if (function == "from_double" || function == "from_float") {
        detail::pmt_arity(function, arguments, 1);
        return pmt::from_double(detail::pmt_number(function, arguments[0]));
    }
    if (function == "from_complex") {
        if (arguments.size() != 1 && arguments.size() != 2)
            throw std::runtime_error("pmt.from_complex() takes 1 or 2 arguments");
        const double real = detail::pmt_number(function, arguments[0]);
        const double imag =
            arguments.size() == 2 ? detail::pmt_number(function, arguments[1]) : 0.0;
        return pmt::from_complex(real, imag);
    }
    if (function == "cons")
        return (detail::pmt_arity(function, arguments, 2),
                pmt::cons(argument(0), argument(1)));
    if (function == "car")
        return (detail::pmt_arity(function, arguments, 1), pmt::car(argument(0)));
    if (function == "cdr")
        return (detail::pmt_arity(function, arguments, 1), pmt::cdr(argument(0)));
    if (function == "make_dict")
        return (detail::pmt_arity(function, arguments, 0), pmt::make_dict());
    if (function == "dict_add")
        return (detail::pmt_arity(function, arguments, 3),
                pmt::dict_add(argument(0), argument(1), argument(2)));
    if (function == "list1" || function == "list2" || function == "list3" ||
        function == "list4" || function == "list5") {
        const std::size_t expected = static_cast<std::size_t>(function.back() - '0');
        detail::pmt_arity(function, arguments, expected);
        pmt::pmt_t list = pmt::PMT_NIL;
        for (std::size_t i = expected; i > 0; --i)
            list = pmt::cons(argument(i - 1), list);
        return list;
    }
    if (function == "init_u8vector")
        return detail::pmt_vector<std::uint8_t>(function, arguments, &pmt::init_u8vector);
    if (function == "init_s8vector")
        return detail::pmt_vector<std::int8_t>(function, arguments, &pmt::init_s8vector);
    if (function == "init_u16vector")
        return detail::pmt_vector<std::uint16_t>(function, arguments, &pmt::init_u16vector);
    if (function == "init_s16vector")
        return detail::pmt_vector<std::int16_t>(function, arguments, &pmt::init_s16vector);
    if (function == "init_u32vector")
        return detail::pmt_vector<std::uint32_t>(function, arguments, &pmt::init_u32vector);
    if (function == "init_s32vector")
        return detail::pmt_vector<std::int32_t>(function, arguments, &pmt::init_s32vector);
    if (function == "init_f32vector")
        return detail::pmt_vector<float>(function, arguments, &pmt::init_f32vector);
    if (function == "init_f64vector")
        return detail::pmt_vector<double>(function, arguments, &pmt::init_f64vector);
    if (function == "init_c32vector")
        return detail::pmt_vector<gr_complex>(function, arguments, &pmt::init_c32vector);

    throw std::runtime_error(
        "pmt." + function + "() is not one of the PMT constructors this runner "
        "understands; add it to pmt_from_expression() in registry_helpers.hpp");
}

inline pmt::pmt_t pmt_value(const nlohmann::json& params,
                            const char* key,
                            const std::string& fallback = std::string())
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null())
        return pmt_from_expression(fallback);
    if (item->is_boolean())
        return pmt::from_bool(item->get<bool>());
    if (item->is_number_integer())
        return pmt::from_long(item->get<long>());
    if (item->is_number())
        return pmt::from_double(item->get<double>());
    // Not text() -- that strips the quotes a symbol literal is written with, and
    // `"3"` (a symbol) has to stay distinguishable from `3` (a number).
    const std::string value = item->is_string() ? item->get<std::string>() : item->dump();
    return pmt_from_expression(value.empty() ? fallback : value);
}

// --- Tag objects ------------------------------------------------------------
//
// GRC's Tag Object is a *variable* (`variable_tag_object`) rather than a block:
// it builds one gr::tag_t, and a Vector Source's `tags` parameter names the ones
// it should emit. Like the constellation and CC decoder variables, the factory
// files each object here under its variable name before any block is built, and
// the block that consumes them looks them up. Kept inline beside the parameter
// decoders because the consumer is a *generated* factory, which has nothing else
// from registry.cpp in scope. That works because both ends are in the main
// module: a function-local static in an inline function is one object per
// module, so a deferred module gaining a tag-list parameter would read an empty
// map of its own and would need this moved behind an exported symbol instead.
inline std::map<std::string, gr::tag_t>& runtime_tag_objects()
{
    static std::map<std::string, gr::tag_t> objects;
    return objects;
}

inline std::vector<gr::tag_t> tag_objects(const nlohmann::json& params, const char* key)
{
    auto item = params.find(key);
    if (item == params.end() || item->is_null() || !item->is_string())
        return {};
    std::string value = detail::trim(strip_quotes(item->get<std::string>()));
    if (value.empty() || value == "[]" || value == "()")
        return {};
    if (value.size() >= 2 && (value.front() == '[' || value.front() == '(') &&
        (value.back() == ']' || value.back() == ')'))
        value = value.substr(1, value.size() - 2);
    std::vector<gr::tag_t> tags;
    for (const std::string& name : detail::pmt_arguments(value)) {
        if (name.empty())
            continue;
        auto found = runtime_tag_objects().find(strip_quotes(name));
        if (found == runtime_tag_objects().end())
            throw std::runtime_error(std::string(key) +
                                     " names an unknown Tag Object: " + name);
        tags.push_back(found->second);
    }
    return tags;
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
