#pragma once
// Minimal YAML reader for the GNU Radio Companion (.grc) subset the editor
// emits (and that desktop GRC produces): block-style mappings, block sequences,
// flow sequences ([a, b]), and plain/single/double-quoted scalars. It is
// indentation-driven so both the editor's 4-space output and older 2-space
// files parse. Produces an nlohmann::json tree; scalars resolve to YAML-core
// types (int/float/bool/null/string). This is not a general YAML parser — it
// covers exactly what flowgraphs use.

#include "json.hpp" // nlohmann::json

#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace grc_yaml {

using nlohmann::json;

inline std::string trim(const std::string& s)
{
    std::size_t a = s.find_first_not_of(" \t");
    if (a == std::string::npos) return "";
    std::size_t b = s.find_last_not_of(" \t");
    return s.substr(a, b - a + 1);
}

// Strip an unquoted trailing "# comment" (only when preceded by whitespace).
inline std::string strip_comment(const std::string& s)
{
    for (std::size_t i = 0; i < s.size(); ++i)
        if (s[i] == '#' && (i == 0 || s[i - 1] == ' ' || s[i - 1] == '\t'))
            return trim(s.substr(0, i));
    return s;
}

inline json parse_double_quoted(const std::string& s)
{
    std::string out;
    for (std::size_t i = 1; i + 1 < s.size(); ++i) {
        char c = s[i];
        if (c != '\\') { out += c; continue; }
        char e = s[++i];
        switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '0': out += '\0'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case 'x': case 'u': case 'U': {
            int n = (e == 'x') ? 2 : (e == 'u') ? 4 : 8;
            unsigned long cp = std::stoul(s.substr(i + 1, n), nullptr, 16);
            i += n;
            // Encode code point as UTF-8.
            if (cp < 0x80) out += static_cast<char>(cp);
            else if (cp < 0x800) {
                out += static_cast<char>(0xC0 | (cp >> 6));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else if (cp < 0x10000) {
                out += static_cast<char>(0xE0 | (cp >> 12));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            } else {
                out += static_cast<char>(0xF0 | (cp >> 18));
                out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
                out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                out += static_cast<char>(0x80 | (cp & 0x3F));
            }
            break;
        }
        default: out += e; break;
        }
    }
    return json(out);
}

inline bool is_int(const std::string& s)
{
    if (s.empty()) return false;
    std::size_t i = (s[0] == '+' || s[0] == '-') ? 1 : 0;
    if (i == s.size()) return false;
    for (; i < s.size(); ++i)
        if (!std::isdigit(static_cast<unsigned char>(s[i]))) return false;
    return true;
}

inline bool is_float(const std::string& s)
{
    if (s.empty()) return false;
    char* end = nullptr;
    std::strtod(s.c_str(), &end);
    return end == s.c_str() + s.size() &&
           s.find_first_of(".eEnN") != std::string::npos; // has a float marker
}

// Resolve a bare (already comment-stripped, trimmed) scalar token.
inline json parse_scalar(const std::string& raw)
{
    if (raw.empty()) return json("");
    char c0 = raw[0];
    if (c0 == '\'') {
        std::string inner = raw.substr(1, raw.size() - 2);
        std::string out;
        for (std::size_t i = 0; i < inner.size(); ++i) {
            if (inner[i] == '\'' && i + 1 < inner.size() && inner[i + 1] == '\'') { out += '\''; ++i; }
            else out += inner[i];
        }
        return json(out);
    }
    if (c0 == '"') return parse_double_quoted(raw);
    if (raw == "null" || raw == "Null" || raw == "NULL" || raw == "~") return json(nullptr);
    if (raw == "true" || raw == "True" || raw == "TRUE") return json(true);
    if (raw == "false" || raw == "False" || raw == "FALSE") return json(false);
    // strtoll/strtod are non-throwing; std::stoll/std::stod would throw on an
    // out-of-range value, which escapes uncatchably in this Emscripten build.
    if (is_int(raw)) {
        errno = 0; char* e = nullptr;
        long long v = std::strtoll(raw.c_str(), &e, 10);
        if (errno == 0 && e == raw.c_str() + raw.size()) return json(v);
    }
    if (is_float(raw)) {
        errno = 0; char* e = nullptr;
        double v = std::strtod(raw.c_str(), &e);
        if (errno == 0 && e == raw.c_str() + raw.size()) return json(v);
    }
    return json(raw);
}

class Parser {
public:
    explicit Parser(const std::string& text) { tokenize(text); }

    json parse() { return parse_node(0); }

private:
    struct Line { int indent; std::string content; };
    std::vector<Line> lines_;
    std::size_t i_ = 0;

    void tokenize(const std::string& text)
    {
        std::size_t pos = 0;
        while (pos <= text.size()) {
            std::size_t nl = text.find('\n', pos);
            std::string raw = text.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
            if (!raw.empty() && raw.back() == '\r') raw.pop_back();
            pos = (nl == std::string::npos) ? text.size() + 1 : nl + 1;
            // Skip blank lines and full-line comments.
            std::string t = trim(raw);
            if (t.empty() || t[0] == '#') continue;
            int indent = 0;
            while (indent < (int)raw.size() && raw[indent] == ' ') ++indent;
            lines_.push_back({ indent, raw.substr(indent) });
        }
    }

    static bool is_seq_line(const std::string& c) { return c == "-" || c.rfind("- ", 0) == 0; }

    json parse_node(int min_indent)
    {
        if (i_ >= lines_.size() || lines_[i_].indent < min_indent) return json(nullptr);
        return is_seq_line(lines_[i_].content) ? parse_seq(lines_[i_].indent)
                                               : parse_map(lines_[i_].indent);
    }

    json parse_map(int indent)
    {
        json obj = json::object();
        while (i_ < lines_.size() && lines_[i_].indent == indent && !is_seq_line(lines_[i_].content)) {
            const std::string line = lines_[i_].content;
            std::size_t colon = find_colon(line);
            if (colon == std::string::npos) break;
            std::string key = trim(line.substr(0, colon));
            json k = parse_scalar(key);
            std::string key_str = k.is_string() ? k.get<std::string>() : key;
            std::string rest = trim(line.substr(colon + 1));
            ++i_;
            if (rest.empty()) {
                // A block sequence value may sit at the SAME indent as its key
                // (GRC's `blocks:`/`connections:`); a nested mapping is deeper.
                if (i_ < lines_.size() && is_seq_line(lines_[i_].content) && lines_[i_].indent == indent)
                    obj[key_str] = parse_seq(indent);
                else if (i_ < lines_.size() && lines_[i_].indent > indent)
                    obj[key_str] = parse_node(lines_[i_].indent);
                else obj[key_str] = json(nullptr);
            } else {
                obj[key_str] = parse_inline(rest);
            }
        }
        return obj;
    }

    json parse_seq(int indent)
    {
        json arr = json::array();
        while (i_ < lines_.size() && lines_[i_].indent == indent && is_seq_line(lines_[i_].content)) {
            const std::string line = lines_[i_].content;
            if (line == "-") { ++i_; arr.push_back(parse_node(indent + 1)); continue; }
            std::string after_raw = line.substr(1);                 // after '-'
            std::string after = trim(after_raw);
            // A mapping item: "key: ..." whose keys align to a deeper column.
            if (looks_like_map_entry(after)) {
                int lead = 0;
                while (lead < (int)after_raw.size() && after_raw[lead] == ' ') ++lead;
                int content_indent = indent + 1 + lead;
                lines_[i_].indent = content_indent;
                lines_[i_].content = after;
                arr.push_back(parse_map(content_indent));
            } else {
                ++i_;
                arr.push_back(parse_inline(after));
            }
        }
        return arr;
    }

    json parse_inline(const std::string& s)
    {
        if (!s.empty() && s[0] == '[') return parse_flow_seq(s);
        return parse_scalar(strip_comment(s));
    }

    json parse_flow_seq(const std::string& s)
    {
        json arr = json::array();
        std::size_t end = s.rfind(']');
        std::string body = s.substr(1, end == std::string::npos ? std::string::npos : end - 1);
        // Split on top-level commas (respecting quotes).
        std::string cur;
        char quote = 0;
        auto flush = [&]() { std::string t = trim(cur); if (!t.empty()) arr.push_back(parse_scalar(t)); cur.clear(); };
        for (char c : body) {
            if (quote) { cur += c; if (c == quote) quote = 0; }
            else if (c == '\'' || c == '"') { quote = c; cur += c; }
            else if (c == ',') flush();
            else cur += c;
        }
        flush();
        return arr;
    }

    // Find the ':' that separates a mapping key from its value (skipping quotes).
    static std::size_t find_colon(const std::string& s)
    {
        char quote = 0;
        for (std::size_t i = 0; i < s.size(); ++i) {
            char c = s[i];
            if (quote) { if (c == quote) quote = 0; }
            else if (c == '\'' || c == '"') quote = c;
            else if (c == ':' && (i + 1 == s.size() || s[i + 1] == ' ')) return i;
        }
        return std::string::npos;
    }

    static bool looks_like_map_entry(const std::string& s) { return find_colon(s) != std::string::npos; }
};

inline json parse(const std::string& text) { return Parser(text).parse(); }

} // namespace grc_yaml
