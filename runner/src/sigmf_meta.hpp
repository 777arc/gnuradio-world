#pragma once

// The half of the SigMF mapping that has to walk a parsed JSON document: a
// .sigmf-meta arrives as text, so turning a recording's capture segments and
// annotations into a tag plan means reading JSON.
//
// It lives here rather than in blocks/ for the reason AGENTS.md gives -- code
// that takes a `const json&` is factory-side -- and it includes sigmf_tags.hpp
// so the tag names and metadata keys have exactly one definition shared with the
// sink direction. Change a name there and both ends follow.

#include "sigmf_tags.hpp"

#include <nlohmann/json.hpp>
#include <pmt/pmt.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace sigmf {

// A JSON value as a PMT. The inverse of pmt_to_json() in sigmf_tags.hpp; keep
// the two in step, since a recording round-tripping through SigMF Source and
// SigMF Sink passes through both.
inline pmt::pmt_t json_to_pmt(const nlohmann::json& value)
{
    if (value.is_null())
        return pmt::PMT_NIL;
    if (value.is_boolean())
        return pmt::from_bool(value.get<bool>());
    if (value.is_number_unsigned())
        return pmt::from_uint64(value.get<std::uint64_t>());
    if (value.is_number_integer())
        return pmt::from_long(static_cast<long>(value.get<std::int64_t>()));
    if (value.is_number_float())
        return pmt::from_double(value.get<double>());
    if (value.is_string())
        return pmt::string_to_symbol(value.get<std::string>());
    if (value.is_array()) {
        pmt::pmt_t vector = pmt::make_vector(value.size(), pmt::PMT_NIL);
        for (std::size_t i = 0; i < value.size(); ++i)
            pmt::vector_set(vector, i, json_to_pmt(value[i]));
        return vector;
    }
    if (value.is_object()) {
        pmt::pmt_t dict = pmt::make_dict();
        for (const auto& [key, member] : value.items())
            dict = pmt::dict_add(dict, pmt::string_to_symbol(key), json_to_pmt(member));
        return dict;
    }
    return pmt::PMT_NIL;
}

// A number out of a SigMF object, tolerating the type sloppiness real
// recordings contain (a frequency written as a string, a sample_start written
// as a float). Returns `fallback` when there is nothing usable.
inline double sigmf_number(const nlohmann::json& object,
                           const char* key,
                           double fallback = 0.0)
{
    if (!object.is_object() || !object.contains(key))
        return fallback;
    const auto& value = object.at(key);
    if (value.is_number())
        return value.get<double>();
    if (value.is_string()) {
        try {
            return std::stod(value.get<std::string>());
        } catch (...) {
            return fallback;
        }
    }
    return fallback;
}

inline std::string sigmf_string(const nlohmann::json& object, const char* key)
{
    if (!object.is_object() || !object.contains(key))
        return {};
    const auto& value = object.at(key);
    return value.is_string() ? value.get<std::string>() : std::string();
}

inline std::string datatype_of(const nlohmann::json& meta)
{
    return meta.is_object() && meta.contains("global")
               ? sigmf_string(meta.at("global"), "core:datatype")
               : std::string();
}

inline double sample_rate_of(const nlohmann::json& meta)
{
    return meta.is_object() && meta.contains("global")
               ? sigmf_number(meta.at("global"), KEY_SAMPLE_RATE, 0.0)
               : 0.0;
}

// The capture segment in effect at absolute sample `offset_items`: the last one
// whose sample_start is at or before it. Returned as an index into the array so
// two segments sharing a sample_start resolve to exactly one of them.
//
// This exists because a capture segment describes every sample from its own
// start *onward*, not just the one it sits on. Every SigMF recording has a
// segment at sample 0, so a selection starting anywhere past the beginning has
// one in effect -- and simply dropping it, which is what this did, left the
// stream with no rx_freq, no rx_rate and no rx_time at all.
inline std::size_t enclosing_capture(const nlohmann::json& captures,
                                     std::uint64_t offset_items)
{
    const std::size_t none = static_cast<std::size_t>(-1);
    std::size_t found = none;
    double best = 0.0;
    for (std::size_t i = 0; i < captures.size(); ++i) {
        if (!captures[i].is_object())
            continue;
        const double start = sigmf_number(captures[i], KEY_SAMPLE_START, 0.0);
        if (!(start >= 0.0) || static_cast<std::uint64_t>(start) > offset_items)
            continue;
        if (found == none || start >= best) {
            found = i;
            best = start;
        }
    }
    return found;
}

// Whether an annotation is still running at absolute sample `offset_items`: it
// began earlier and its extent reaches past. The same argument as a capture
// segment -- an annotation covering the selection's first sample belongs on it.
inline bool annotation_spans(const nlohmann::json& annotation, std::uint64_t offset_items)
{
    const double start = sigmf_number(annotation, KEY_SAMPLE_START, 0.0);
    const double count = sigmf_number(annotation, KEY_SAMPLE_COUNT, 0.0);
    if (!(start >= 0.0) || !(count > 0.0))
        return false;
    return static_cast<std::uint64_t>(start) < offset_items &&
           start + count > static_cast<double>(offset_items);
}

// The recording's metadata as tags to emit while reading it.
//
// Offsets come out counted from the first sample of a pass -- the block's Offset
// parameter subtracted -- so a trimmed selection tags the right samples and a
// repeat pass re-emits the same plan. Anything that begins before the selection
// and does not reach into it is dropped; anything still in effect at the
// selection's first sample is carried onto that sample instead. Anything past
// the end is harmless (the block never reaches it), so the tail is only clipped
// when Length actually bounds it.
inline std::vector<TagPlanEntry> build_tag_plan(const nlohmann::json& meta,
                                                std::uint64_t offset_items,
                                                std::uint64_t length_items)
{
    std::vector<TagPlanEntry> plan;
    if (!meta.is_object())
        return plan;

    const double rate = sample_rate_of(meta);

    // `carried` marks an entry whose extent covers the selection's first
    // sample: it lands at relative offset 0 rather than being dropped.
    const auto push = [&](double absolute_start,
                          bool carried,
                          const char* name,
                          pmt::pmt_t value) {
        if (!(absolute_start >= 0.0))
            return;
        const auto start = static_cast<std::uint64_t>(absolute_start);
        std::uint64_t relative = 0;
        if (start >= offset_items) {
            relative = start - offset_items;
            if (length_items && relative >= length_items)
                return;
        } else if (!carried) {
            return;
        }
        plan.push_back({ relative, pmt::string_to_symbol(name), std::move(value) });
    };

    if (meta.contains("captures") && meta.at("captures").is_array()) {
        const nlohmann::json& captures = meta.at("captures");
        const std::size_t enclosing = enclosing_capture(captures, offset_items);
        for (std::size_t i = 0; i < captures.size(); ++i) {
            const auto& capture = captures[i];
            if (!capture.is_object())
                continue;
            const double start = sigmf_number(capture, KEY_SAMPLE_START, 0.0);
            const bool carried = (i == enclosing);

            // The conventional receive tags first: these are the names blocks
            // elsewhere in GNU Radio already look for.
            if (capture.contains(KEY_FREQUENCY))
                push(start, carried, TAG_RX_FREQ,
                     pmt::from_double(sigmf_number(capture, KEY_FREQUENCY)));
            if (rate > 0.0)
                push(start, carried, TAG_RX_RATE, pmt::from_double(rate));
            std::uint64_t seconds = 0;
            double fraction = 0.0;
            const std::string datetime = sigmf_string(capture, KEY_DATETIME);
            if (!datetime.empty() && iso8601_to_epoch(datetime, seconds, fraction))
                push(start,
                     carried,
                     TAG_RX_TIME,
                     pmt::cons(pmt::from_uint64(seconds), pmt::from_double(fraction)));

            // Then the whole segment, so nothing in it is lost on the way to a
            // SigMF Sink downstream.
            push(start, carried, TAG_CAPTURE, json_to_pmt(capture));
        }
    }

    if (meta.contains("annotations") && meta.at("annotations").is_array()) {
        for (const auto& annotation : meta.at("annotations")) {
            if (!annotation.is_object())
                continue;
            push(sigmf_number(annotation, KEY_SAMPLE_START, 0.0),
                 annotation_spans(annotation, offset_items),
                 TAG_ANNOTATION,
                 json_to_pmt(annotation));
        }
    }

    // BrowserFileSource walks the plan with a forward-only cursor, so order is
    // part of the contract. stable_sort keeps a capture's scalar tags ahead of
    // its dictionary at the same offset, which is the order they read best in.
    std::stable_sort(plan.begin(),
                     plan.end(),
                     [](const TagPlanEntry& a, const TagPlanEntry& b) {
                         return a.offset < b.offset;
                     });
    return plan;
}

} // namespace sigmf
