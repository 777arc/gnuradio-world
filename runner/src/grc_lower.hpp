#pragma once
// Lower a parsed .grc flowgraph into the {blocks, connections} shape the runner
// consumes. This is the "generate" step GRC/the editor used to do; kept free of
// GNU Radio headers so it can be unit-tested natively (see tests).

#include <nlohmann/json.hpp>

#include <cerrno>
#include <cstdlib>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace grc_lower {

using nlohmann::json;

// The QT GUI controls: widgets that publish a value other blocks' numeric
// parameters bind to. They stay live in the graph (unlike plain `variable`
// blocks, whose values are inlined away), so run_now() builds them before
// anything else and keeps them for the whole run.
//
// The id prefix is the rule, matching the scan in lower() below and `isVar` in
// editor/src/expr.ts. Some of these also carry a message port and therefore a
// gr::block, which run_now() connects as it would any other block's; Digital
// Number Control is the one whose id predates the naming convention.
inline bool is_variable_control(const std::string& id) {
    return id.rfind("variable_qtgui_", 0) == 0 ||
           id == "qtgui_msgdigitalnumbercontrol";
}

// A GRC scalar (int/string) rendered as a string, for connection port tokens.
inline std::string scalar_to_str(const json& v) {
    if (v.is_string()) return v.get<std::string>();
    if (v.is_number_integer()) return std::to_string(v.get<long long>());
    if (v.is_number()) return std::to_string(v.get<double>());
    return v.dump();
}

// GRC stores every parameter as a string; the runner's factories expect numbers
// for numeric params (as the editor's JSON used to provide). Convert fully
// numeric strings back to numbers; leave expressions/enums/text as strings.
// Uses strtoll/strtod (non-throwing): std::stoll/std::stod on non-numeric text
// throw, and in this Emscripten build that exception escapes uncatchably.
// Parameters whose value is text even when it reads as a number, so
// coerce_numeric below must leave them alone. A device serial number is the
// case that forced this: "00000001" is not the integer 1, and coercing it loses
// the leading zeros the dongle actually reports, so the serial never matches
// again. Anything here is a parameter a *human* types or a picker fills in,
// never one a factory wants as a number.
inline bool is_text_param(const std::string& block_id, const std::string& param) {
    return param == "device" &&
           (block_id == "wasm_rtlsdr_source" ||
            block_id == "wasm_plutosdr_source" ||
            block_id == "wasm_plutosdr_sink");
}

inline json coerce_numeric(const std::string& s) {
    if (s.empty()) return json(s);
    const char* b = s.c_str();
    char* end = nullptr;
    errno = 0;
    long long ll = std::strtoll(b, &end, 10);
    if (end == b + s.size() && errno == 0) return json(ll);
    errno = 0; end = nullptr;
    double d = std::strtod(b, &end);
    if (end == b + s.size() && end != b && errno == 0) return json(d);
    return json(s);
}

// Lower: drop the options block, `note` annotations, disabled blocks and their
// wires; inline plain `variable` values into referencing params; hop stream
// connections over bypassed blocks; keep variable controls. Connection port
// tokens in .grc are already stream indices (== GR connect port numbers), so no
// remapping here.
inline json lower(const json& g) {
    static const json empty_arr = json::array();
    const json& blocks = (g.contains("blocks") && g["blocks"].is_array()) ? g["blocks"] : empty_arr;
    const json& rawconns = (g.contains("connections") && g["connections"].is_array()) ? g["connections"] : empty_arr;

    std::map<std::string, std::string> stateOf;
    for (const auto& b : blocks) {
        if (!b.contains("name") || !b["name"].is_string()) continue;
        std::string st = "enabled";
        if (b.contains("states") && b["states"].is_object()) {
            // GRC writes `state: enabled|disabled|bypassed`, but files saved by
            // older versions (several gr-satellites examples) carry the boolean
            // `state: true|false` instead.
            const auto& s = b["states"];
            auto it = s.find("state");
            if (it != s.end() && it->is_boolean())
                st = it->get<bool>() ? "enabled" : "disabled";
            else if (it != s.end() && it->is_string())
                st = it->get<std::string>();
        }
        stateOf[b["name"].get<std::string>()] = st;
    }
    auto enabled = [&](const std::string& n) { auto it = stateOf.find(n); return it != stateOf.end() && it->second != "disabled"; };
    auto bypassed = [&](const std::string& n) { auto it = stateOf.find(n); return it != stateOf.end() && it->second == "bypassed"; };
    auto active = [&](const std::string& n) { return enabled(n) && !bypassed(n); };

    // Plain `variable` blocks: inline their (possibly chained) numeric values.
    std::map<std::string, std::string> plainVar;
    for (const auto& b : blocks) {
        if (b.value("id", std::string()) != "variable") continue;
        const std::string name = b.value("name", std::string());
        if (name.empty() || !active(name) || !b.contains("parameters") || !b["parameters"].is_object()) continue;
        plainVar[name] = b["parameters"].value("value", std::string());
    }
    std::function<json(const std::string&, std::set<std::string>&)> resolveVar =
        [&](const std::string& name, std::set<std::string>& seen) -> json {
        auto it = plainVar.find(name);
        if (it == plainVar.end() || seen.count(name)) return json(name);
        seen.insert(name);
        const std::string raw = it->second;
        json numeric = coerce_numeric(raw);
        if (!numeric.is_string()) return numeric;       // a concrete number
        if (plainVar.count(raw)) return resolveVar(raw, seen);
        return json(raw);
    };
    auto resolveParams = [&](const std::string& block_id, const json& params) -> json {
        json r = json::object();
        if (params.is_object())
            for (auto& it : params.items()) {
                const json& v = it.value();
                if (v.is_string()) {
                    const std::string s = v.get<std::string>();
                    if (is_text_param(block_id, it.key())) r[it.key()] = s;
                    else if (plainVar.count(s)) { std::set<std::string> seen; r[it.key()] = resolveVar(s, seen); }
                    else r[it.key()] = coerce_numeric(s);
                } else r[it.key()] = v;
            }
        return r;
    };

    // Stream adjacency for bypass hopping.
    std::multimap<std::string, std::pair<std::string, std::string>> outStream;
    for (const auto& c : rawconns)
        if (c.is_array() && c.size() >= 4 && c[0].is_string() && c[2].is_string())
            outStream.emplace(c[0].get<std::string>(),
                              std::make_pair(c[2].get<std::string>(), scalar_to_str(c[3])));
    std::function<std::vector<std::pair<std::string, std::string>>(const std::string&, const std::string&, std::set<std::string>&)>
        resolveDown = [&](const std::string& name, const std::string& port, std::set<std::string>& seen) {
            std::vector<std::pair<std::string, std::string>> res;
            if (active(name)) { res.push_back({ name, port }); return res; }
            if (!bypassed(name) || seen.count(name)) return res;
            seen.insert(name);
            auto range = outStream.equal_range(name);
            for (auto it = range.first; it != range.second; ++it) {
                auto sub = resolveDown(it->second.first, it->second.second, seen);
                res.insert(res.end(), sub.begin(), sub.end());
            }
            return res;
        };

    json connsOut = json::array();
    std::set<std::string> emitted;
    for (const auto& c : rawconns) {
        if (c.is_array() && c.size() >= 4 && c[0].is_string() && c[2].is_string()) {
            const std::string src = c[0].get<std::string>(), sp = scalar_to_str(c[1]);
            if (!active(src)) continue;
            std::set<std::string> seen;
            for (auto& d : resolveDown(c[2].get<std::string>(), scalar_to_str(c[3]), seen)) {
                const std::string key = src + "|" + sp + ">" + d.first + "|" + d.second;
                if (!emitted.insert(key).second) continue;
                json conn = json::array();
                conn.push_back(src);
                conn.push_back(static_cast<int>(std::strtol(sp.c_str(), nullptr, 10)));
                conn.push_back(d.first);
                conn.push_back(static_cast<int>(std::strtol(d.second.c_str(), nullptr, 10)));
                connsOut.push_back(std::move(conn));
            }
        } else if (c.is_object()) {                       // message connection
            const std::string src = c.value("src_blk_id", std::string());
            const std::string dst = c.value("snk_blk_id", std::string());
            if (!active(src) || !active(dst)) continue;
            json conn = json::array();
            conn.push_back(src); conn.push_back(c.value("src_port_id", std::string()));
            conn.push_back(dst); conn.push_back(c.value("snk_port_id", std::string()));
            conn.push_back("message");
            connsOut.push_back(std::move(conn));
        }
    }

    json blocksOut = json::array();
    for (const auto& b : blocks) {
        const std::string id = b.value("id", std::string()), name = b.value("name", std::string());
        // `note` is a canvas annotation (GRC's comment block): it carries text
        // for the editor only and has no GNU Radio block behind it, so it never
        // reaches the factory registry.
        if (id == "options" || id == "variable" || id == "note" || !active(name)) continue;
        json nb = json::object();
        nb["name"] = name; nb["id"] = id;
        nb["params"] = (b.contains("parameters") && b["parameters"].is_object())
            ? resolveParams(id, b["parameters"]) : json::object();
        blocksOut.push_back(std::move(nb));
    }

    // The flowgraph's variables, by name. Every *parameter* above already has the
    // plain ones inlined, so nothing in the block registry needs this; the
    // Embedded Python Block does, because its parameter expressions are evaluated
    // by Python rather than by the editor, and `samp_rate/2` is only meaningful
    // with samp_rate in scope. See runner.cpp's Python prepare step.
    //
    // The live controls (QT GUI Range and friends) are here too, at their initial
    // value, and deliberately *not* in plainVar: inlining them into every block's
    // parameters would erase the very names run_now() matches to wire a control's
    // setter to a parameter. A Python Block's parameter set to a Range's ID gets
    // both -- Python evaluates the name to the starting value, and the Range then
    // drives the block's callback exactly as it drives a C++ block's setter.
    json variables = json::object();
    for (const auto& [name, raw] : plainVar) {
        std::set<std::string> seen;
        variables[name] = resolveVar(name, seen);
    }
    for (const auto& b : blocks) {
        const std::string id = b.value("id", std::string());
        if (!is_variable_control(id)) continue;
        const std::string name = b.value("name", std::string());
        if (name.empty() || !active(name) || !b.contains("parameters")) continue;
        const json value = coerce_numeric(b["parameters"].value("value", std::string()));
        if (!value.is_string()) variables[name] = value;
    }

    json out = json::object();
    out["blocks"] = std::move(blocksOut);
    out["connections"] = std::move(connsOut);
    out["variables"] = std::move(variables);
    return out;
}

} // namespace grc_lower
