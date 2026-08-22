#pragma once

// SigMF metadata <-> GNU Radio stream tags.
//
// SigMF Source turns a recording's capture segments and annotations into tags;
// SigMF Sink turns tags back into capture segments and annotations. The two are
// one specification, and the surest way to break a round trip is to let the two
// halves drift, so the tag names, the metadata keys and the value encoding all
// live here and both directions read them from this one header.
//
// This header is plain C++ and pmt, with no nlohmann/json, per the rule in
// AGENTS.md: it takes ordinary C++ arguments rather than a flowgraph parameter
// object. The half of the source direction that does need to walk a parsed JSON
// document -- because the .sigmf-meta arrives as JSON text -- is factory-side in
// runner/src/sigmf_meta.hpp, which includes this header for the names below.

#include <pmt/pmt.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace sigmf {

// ---- names shared by both directions ---------------------------------------

// The two dictionary tags. They carry a whole SigMF object each, which is what
// makes a recording survive a trip through a flowgraph unchanged; the scalar
// tags beside them are the ones other GNU Radio blocks already understand.
inline constexpr const char* TAG_CAPTURE = "sigmf:capture";
inline constexpr const char* TAG_ANNOTATION = "sigmf:annotation";

// GNU Radio's conventional receive tags, as emitted by UHD and by the source
// blocks here. A capture segment is exactly the information these carry.
inline constexpr const char* TAG_RX_FREQ = "rx_freq";
inline constexpr const char* TAG_RX_RATE = "rx_rate";
inline constexpr const char* TAG_RX_TIME = "rx_time";

inline constexpr const char* KEY_SAMPLE_START = "core:sample_start";
inline constexpr const char* KEY_SAMPLE_COUNT = "core:sample_count";
inline constexpr const char* KEY_FREQUENCY = "core:frequency";
inline constexpr const char* KEY_DATETIME = "core:datetime";
inline constexpr const char* KEY_SAMPLE_RATE = "core:sample_rate";
inline constexpr const char* KEY_LABEL = "core:label";

// Where a tag that is neither a SigMF dictionary nor a conventional receive tag
// puts its value. Namespaced, because SigMF requires an extension prefix for any
// key outside core:.
inline constexpr const char* KEY_TAG_VALUE = "gnuradio:value";

// One tag the source is to emit, at an offset counted from the first sample of
// a pass -- so a trimmed selection and every repeat pass tag the same places.
struct TagPlanEntry {
    std::uint64_t offset;
    pmt::pmt_t key;
    pmt::pmt_t value;
};

// ---- JSON text encoding ----------------------------------------------------

inline std::string json_escape(const std::string& text)
{
    std::string out;
    out.reserve(text.size() + 2);
    out.push_back('"');
    for (const unsigned char c : text) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buffer[8];
                std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
                out += buffer;
            } else {
                out.push_back(static_cast<char>(c));
            }
        }
    }
    out.push_back('"');
    return out;
}

// JSON has no NaN and no infinity, so a value that is neither becomes null
// rather than text no parser will accept.
inline std::string json_number(double value)
{
    if (!std::isfinite(value))
        return "null";
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.17g", value);
    return buffer;
}

// A uniform vector's elements, for the numeric types a tag realistically holds.
// Anything else falls through to pmt's own printed form as a JSON string, which
// is lossy but readable and never invalid.
inline bool uniform_vector_json(const pmt::pmt_t& value, std::string& out)
{
    std::size_t length = 0;
    std::string body;
    const auto append = [&body](double element) {
        if (!body.empty())
            body += ',';
        body += json_number(element);
    };

    if (pmt::is_f32vector(value)) {
        const float* elements = pmt::f32vector_elements(value, length);
        for (std::size_t i = 0; i < length; ++i) append(elements[i]);
    } else if (pmt::is_f64vector(value)) {
        const double* elements = pmt::f64vector_elements(value, length);
        for (std::size_t i = 0; i < length; ++i) append(elements[i]);
    } else if (pmt::is_s32vector(value)) {
        const std::int32_t* elements = pmt::s32vector_elements(value, length);
        for (std::size_t i = 0; i < length; ++i) append(elements[i]);
    } else if (pmt::is_s16vector(value)) {
        const std::int16_t* elements = pmt::s16vector_elements(value, length);
        for (std::size_t i = 0; i < length; ++i) append(elements[i]);
    } else if (pmt::is_s8vector(value)) {
        const std::int8_t* elements = pmt::s8vector_elements(value, length);
        for (std::size_t i = 0; i < length; ++i) append(elements[i]);
    } else if (pmt::is_u8vector(value)) {
        const std::uint8_t* elements = pmt::u8vector_elements(value, length);
        for (std::size_t i = 0; i < length; ++i) append(elements[i]);
    } else {
        return false;
    }
    out = "[" + body + "]";
    return true;
}

// A tag's value as JSON text. The inverse of json_to_pmt() in
// runner/src/sigmf_meta.hpp; keep the two in step.
inline std::string pmt_to_json(const pmt::pmt_t& value)
{
    // PMT_NIL is both the empty list and the empty dictionary, so it has to be
    // tested before is_dict(), which accepts it.
    if (pmt::is_null(value))
        return "null";
    if (pmt::is_bool(value))
        return pmt::is_true(value) ? "true" : "false";
    if (pmt::is_symbol(value))
        return json_escape(pmt::symbol_to_string(value));
    if (pmt::is_uint64(value))
        return std::to_string(pmt::to_uint64(value));
    if (pmt::is_integer(value))
        return std::to_string(static_cast<std::int64_t>(pmt::to_long(value)));
    if (pmt::is_real(value))
        return json_number(pmt::to_double(value));
    if (pmt::is_complex(value)) {
        const auto z = pmt::to_complex(value);
        return "{\"real\":" + json_number(z.real()) +
               ",\"imag\":" + json_number(z.imag()) + "}";
    }

    std::string vector_body;
    if (pmt::is_uniform_vector(value)) {
        if (uniform_vector_json(value, vector_body))
            return vector_body;
        return json_escape(pmt::write_string(value));
    }

    if (pmt::is_vector(value)) {
        std::string body;
        const std::size_t length = pmt::length(value);
        for (std::size_t i = 0; i < length; ++i) {
            if (i)
                body += ',';
            body += pmt_to_json(pmt::vector_ref(value, i));
        }
        return "[" + body + "]";
    }

    // A dictionary built with dict_add is a distinct pmt type; a bare cons pair
    // (rx_time's (secs . frac), say) is not, and becomes a two-element array.
    if (pmt::is_dict(value)) {
        std::map<std::string, std::string> members;
        pmt::pmt_t items = pmt::dict_items(value);
        while (pmt::is_pair(items)) {
            const pmt::pmt_t item = pmt::car(items);
            items = pmt::cdr(items);
            if (!pmt::is_pair(item))
                continue;
            const pmt::pmt_t key = pmt::car(item);
            if (!pmt::is_symbol(key))
                continue;
            // Sorted, and last-writer-wins on a duplicate key, so one dictionary
            // always serializes to one byte sequence.
            members[pmt::symbol_to_string(key)] = pmt_to_json(pmt::cdr(item));
        }
        std::string body;
        for (const auto& [key, encoded] : members) {
            if (!body.empty())
                body += ',';
            body += json_escape(key) + ':' + encoded;
        }
        return "{" + body + "}";
    }

    if (pmt::is_pair(value))
        return "[" + pmt_to_json(pmt::car(value)) + "," +
               pmt_to_json(pmt::cdr(value)) + "]";

    return json_escape(pmt::write_string(value));
}

// ---- the sink direction: tags -> a .sigmf-meta document --------------------

// GNU Radio's rx_time is (whole seconds . fraction) since the epoch; SigMF's
// core:datetime is an ISO-8601 instant in UTC. Anything unrepresentable (a
// negative or absurd epoch, a gmtime failure) yields an empty string, which the
// caller drops rather than writing a malformed timestamp.
inline std::string iso8601_from_epoch(std::uint64_t seconds, double fraction)
{
    if (fraction < 0.0 || fraction >= 1.0 || !std::isfinite(fraction))
        fraction = 0.0;
    const auto stamp = static_cast<std::time_t>(seconds);
    std::tm parts{};
    if (!gmtime_r(&stamp, &parts))
        return {};
    char date[32];
    if (!std::strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &parts))
        return {};
    char millis[8];
    std::snprintf(millis, sizeof(millis), "%03d",
                  static_cast<int>(fraction * 1000.0 + 0.5));
    return std::string(date) + '.' + millis + "Z";
}

// The inverse, for the source direction: core:datetime -> rx_time's two parts.
// Returns false when the text is not an instant this can make sense of, so the
// caller can emit no rx_time at all rather than one at the epoch.
inline bool iso8601_to_epoch(const std::string& text,
                             std::uint64_t& seconds,
                             double& fraction)
{
    int year = 0, month = 0, day = 0, hour = 0, minute = 0;
    double second = 0.0;
    // SigMF requires the 'Z' suffix, so this is always UTC; anything else is
    // rejected rather than silently read as local time.
    if (std::sscanf(text.c_str(),
                    "%4d-%2d-%2dT%2d:%2d:%lf",
                    &year, &month, &day, &hour, &minute, &second) != 6)
        return false;
    if (text.empty() || (text.back() != 'Z' && text.back() != 'z'))
        return false;
    if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31)
        return false;

    std::tm parts{};
    parts.tm_year = year - 1900;
    parts.tm_mon = month - 1;
    parts.tm_mday = day;
    parts.tm_hour = hour;
    parts.tm_min = minute;
    parts.tm_sec = 0;
    const std::time_t whole = timegm(&parts);
    if (whole < 0)
        return false;
    const double floor_second = std::floor(second);
    if (floor_second < 0.0 || floor_second > 60.0)
        return false;
    seconds = static_cast<std::uint64_t>(whole) +
              static_cast<std::uint64_t>(floor_second);
    fraction = second - floor_second;
    return true;
}

// Accumulates the document a SigMF Sink writes when the flowgraph stops.
//
// A SigMF object is held as key -> already-encoded JSON text rather than as a
// parsed value: merging is then a map insert, a repeated key resolves the same
// way every time, and no JSON DOM is needed in a block header.
class MetaBuilder
{
public:
    using Object = std::map<std::string, std::string>;

    // Beyond this many annotations the document stops growing. A tag-happy
    // flowgraph (a correlator on a fast stream) would otherwise consume the heap
    // for metadata nobody will read; overflowed() lets the sink say so once.
    static constexpr std::size_t MAX_ANNOTATIONS = 100000;

    MetaBuilder(std::string datatype,
                double sample_rate,
                double center_freq,
                std::string author,
                std::string description,
                std::string hw_info)
        : d_datatype(std::move(datatype)),
          d_sample_rate(sample_rate),
          d_author(std::move(author)),
          d_description(std::move(description)),
          d_hw_info(std::move(hw_info))
    {
        // Every SigMF recording has at least one capture segment, at sample 0.
        // The block's Center Frequency parameter describes it until an rx_freq
        // tag says otherwise.
        Object first;
        first[KEY_SAMPLE_START] = "0";
        if (std::isfinite(center_freq))
            first[KEY_FREQUENCY] = json_number(center_freq);
        d_captures.emplace(0, std::move(first));
    }

    // Fold one tag, at an absolute sample offset, into the document.
    void add_tag(std::uint64_t offset, const pmt::pmt_t& key, const pmt::pmt_t& value)
    {
        if (!pmt::is_symbol(key))
            return;
        const std::string name = pmt::symbol_to_string(key);

        // A whole capture segment, as SigMF Source emits it: merge it in, so a
        // recording that passes through a flowgraph keeps every capture key it
        // arrived with, not just the ones with a conventional tag.
        if (name == TAG_CAPTURE) {
            Object& capture = d_captures[offset];
            merge_dict(capture, value);
            capture[KEY_SAMPLE_START] = std::to_string(offset);
            return;
        }

        // A whole annotation, likewise. Its sample_start is taken from where the
        // tag actually is, so a trimmed or resampled stream annotates correctly.
        if (name == TAG_ANNOTATION) {
            if (d_annotations.size() >= MAX_ANNOTATIONS) {
                d_overflowed = true;
                return;
            }
            Object annotation;
            merge_dict(annotation, value);
            annotation[KEY_SAMPLE_START] = std::to_string(offset);
            d_annotations.push_back(std::move(annotation));
            return;
        }

        // A retune. Either conventional tag opens a capture segment here, which
        // is what makes a retuned source record as the series of captures it was.
        if (name == TAG_RX_FREQ) {
            Object& capture = d_captures[offset];
            capture[KEY_SAMPLE_START] = std::to_string(offset);
            if (pmt::is_number(value))
                capture[KEY_FREQUENCY] = json_number(pmt::to_double(value));
            return;
        }
        if (name == TAG_RX_TIME) {
            Object& capture = d_captures[offset];
            capture[KEY_SAMPLE_START] = std::to_string(offset);
            const std::string stamp = datetime_from_rx_time(value);
            if (!stamp.empty())
                capture[KEY_DATETIME] = json_escape(stamp);
            return;
        }
        // rx_rate is recognised so it does not become a stray annotation, but it
        // is not recorded: SigMF's sample rate is global and comes from the
        // block's own Sample Rate parameter.
        if (name == TAG_RX_RATE)
            return;

        // Anything else at all -- a correlator's, a decoder's, a burst
        // detector's -- becomes a one-sample annotation labelled with the tag.
        if (d_annotations.size() >= MAX_ANNOTATIONS) {
            d_overflowed = true;
            return;
        }
        Object annotation;
        annotation[KEY_SAMPLE_START] = std::to_string(offset);
        annotation[KEY_SAMPLE_COUNT] = "1";
        annotation[KEY_LABEL] = json_escape(name);
        annotation[KEY_TAG_VALUE] = pmt_to_json(value);
        d_annotations.push_back(std::move(annotation));
    }

    void set_sample_count(std::uint64_t samples) { d_samples = samples; }
    bool overflowed() const { return d_overflowed; }
    std::size_t annotation_count() const { return d_annotations.size(); }
    std::size_t capture_count() const { return d_captures.size(); }

    // The .sigmf-meta text. core:sha512 is deliberately absent: hashing the
    // recording would mean reading back every byte just written.
    std::string document() const
    {
        std::string out = "{\n  \"global\": {\n";
        out += "    \"core:datatype\": " + json_escape(d_datatype) + ",\n";
        out += "    \"core:version\": \"1.0.0\"";
        if (std::isfinite(d_sample_rate) && d_sample_rate > 0.0)
            out += ",\n    \"core:sample_rate\": " + json_number(d_sample_rate);
        out += ",\n    \"core:recorder\": \"GNU Radio World\"";
        if (!d_author.empty())
            out += ",\n    \"core:author\": " + json_escape(d_author);
        if (!d_description.empty())
            out += ",\n    \"core:description\": " + json_escape(d_description);
        if (!d_hw_info.empty())
            out += ",\n    \"core:hw\": " + json_escape(d_hw_info);
        out += ",\n    \"traceability:sample_length\": " + std::to_string(d_samples);
        out += "\n  },\n";

        out += "  \"captures\": [\n";
        bool first = true;
        for (const auto& [offset, capture] : d_captures) {
            (void)offset;
            if (!first)
                out += ",\n";
            first = false;
            out += "    " + encode_object(capture);
        }
        out += "\n  ],\n";

        out += "  \"annotations\": [\n";
        first = true;
        for (const auto& annotation : d_annotations) {
            if (!first)
                out += ",\n";
            first = false;
            out += "    " + encode_object(annotation);
        }
        out += "\n  ]\n}\n";
        return out;
    }

private:
    static std::string encode_object(const Object& object)
    {
        std::string body;
        for (const auto& [key, encoded] : object) {
            if (!body.empty())
                body += ", ";
            body += json_escape(key) + ": " + encoded;
        }
        return "{" + body + "}";
    }

    // Copy a pmt dictionary's members in as encoded JSON. A non-dictionary value
    // is ignored rather than guessed at.
    static void merge_dict(Object& into, const pmt::pmt_t& value)
    {
        if (pmt::is_null(value) || !pmt::is_dict(value))
            return;
        pmt::pmt_t items = pmt::dict_items(value);
        while (pmt::is_pair(items)) {
            const pmt::pmt_t item = pmt::car(items);
            items = pmt::cdr(items);
            if (!pmt::is_pair(item))
                continue;
            const pmt::pmt_t key = pmt::car(item);
            if (pmt::is_symbol(key))
                into[pmt::symbol_to_string(key)] = pmt_to_json(pmt::cdr(item));
        }
    }

    // rx_time is conventionally (uint64 secs . double frac), but a plain number
    // of seconds is accepted too.
    static std::string datetime_from_rx_time(const pmt::pmt_t& value)
    {
        if (pmt::is_pair(value) && !pmt::is_dict(value)) {
            const pmt::pmt_t secs = pmt::car(value);
            const pmt::pmt_t frac = pmt::cdr(value);
            if (!pmt::is_number(secs))
                return {};
            return iso8601_from_epoch(
                static_cast<std::uint64_t>(pmt::to_double(secs)),
                pmt::is_number(frac) ? pmt::to_double(frac) : 0.0);
        }
        if (pmt::is_number(value)) {
            const double seconds = pmt::to_double(value);
            if (seconds < 0.0)
                return {};
            return iso8601_from_epoch(static_cast<std::uint64_t>(seconds),
                                      seconds - std::floor(seconds));
        }
        return {};
    }

    std::string d_datatype;
    double d_sample_rate;
    std::string d_author;
    std::string d_description;
    std::string d_hw_info;
    std::map<std::uint64_t, Object> d_captures;
    std::vector<Object> d_annotations;
    std::uint64_t d_samples = 0;
    bool d_overflowed = false;
};

} // namespace sigmf
