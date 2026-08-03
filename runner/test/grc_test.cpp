// Native regression test for the runner's .grc parser (grc_yaml) and lowering
// (grc_lower). These headers are GNU-Radio-free by design, so this compiles with
// a plain host compiler:
//
//   g++ -std=c++17 -I../src -I../third_party grc_test.cpp -o grc_test && ./grc_test
//
#include "grc_yaml.hpp"
#include "grc_lower.hpp"

#include <cassert>
#include <iostream>
#include <string>

using nlohmann::json;

static const char* kGraph = R"GRC(options:
    parameters:
        id: t
    states:
        coordinate: [10, 10]
        rotation: 0
        state: enabled
blocks:
-   name: freq
    id: variable_qtgui_range
    parameters:
        value: '1500'
    states:
        coordinate: [50, 400]
        rotation: 0
        state: enabled
-   name: rate
    id: variable
    parameters:
        value: '32000'
    states:
        coordinate: [50, 500]
        rotation: 0
        state: enabled
-   name: note_0
    id: note
    parameters:
        note: "a canvas annotation\nover two lines"
    states:
        coordinate: [50, 600]
        rotation: 0
        state: enabled
-   name: x1
    id: analog_sig_source_x
    parameters:
        samp_rate: rate
        frequency: freq
        waveform: analog.GR_COS_WAVE
        name: MULTI-SOURCE
    states:
        coordinate: [50, 70]
        rotation: 0
        state: enabled
-   name: x2
    id: analog_noise_source_x
    parameters:
        seed: '0'
    states:
        coordinate: [50, 250]
        rotation: 0
        state: disabled
-   name: xx3
    id: blocks_add_xx
    parameters:
        type: complex
    states:
        coordinate: [300, 130]
        rotation: 0
        state: enabled
-   name: thr
    id: blocks_throttle2
    parameters:
        samples_per_second: '32000'
        type: complex
    states:
        coordinate: [490, 130]
        rotation: 0
        state: bypassed
-   name: snk
    id: qtgui_time_sink_x
    parameters:
        size: '1024'
    states:
        coordinate: [700, 80]
        rotation: 0
        state: enabled
connections:
- [x1, '0', xx3, '0']
- [x2, '0', xx3, '1']
- [xx3, '0', thr, '0']
- [thr, '0', snk, '0']
)GRC";

static const json* find_block(const json& blocks, const std::string& name) {
    for (const auto& b : blocks)
        if (b.value("name", std::string()) == name) return &b;
    return nullptr;
}

int main() {
    assert(grc_lower::is_variable_control("variable_qtgui_range"));
    assert(grc_lower::is_variable_control("variable_qtgui_check_box"));
    assert(grc_lower::is_variable_control("variable_qtgui_entry"));
    assert(!grc_lower::is_variable_control("variable"));

    // ---- parser ----
    json g = grc_yaml::parse(kGraph);
    assert(g.at("blocks").is_array() && g["blocks"].size() == 8);
    assert(g.at("connections").size() == 4);
    assert(g["options"]["parameters"]["id"] == "t");
    assert(g["blocks"][0]["states"]["coordinate"] == json::array({ 50, 400 }));
    // Quoted numerics parse back as strings; the connection ports too.
    assert(g["blocks"][0]["parameters"]["value"] == "1500");
    assert(g["connections"][0][1] == "0");

    // ---- lowering ----
    json low = grc_lower::lower(g);
    const json& lb = low.at("blocks");
    // Dropped: options (not a block), disabled x2, bypassed thr, plain variable
    // rate, and note_0 (an editor-only canvas annotation).
    // Kept: freq (control), x1, xx3, snk.
    assert(lb.size() == 4);
    assert(find_block(lb, "freq") && find_block(lb, "x1") &&
           find_block(lb, "xx3") && find_block(lb, "snk"));
    assert(find_block(lb, "x2") == nullptr && find_block(lb, "thr") == nullptr &&
           find_block(lb, "rate") == nullptr && find_block(lb, "note_0") == nullptr);

    // Plain variable `rate` is inlined as a number; control ref `freq` is kept.
    const json* x1 = find_block(lb, "x1");
    assert(x1->at("params").at("samp_rate") == 32000);   // inlined variable -> number
    assert(x1->at("params").at("frequency") == "freq");  // control ref preserved
    assert(x1->at("params").at("waveform") == "analog.GR_COS_WAVE");
    assert(x1->at("params").at("name") == "MULTI-SOURCE"); // non-numeric text stays string

    // Connections: x2->xx3 dropped (disabled); xx3->thr->snk hopped to xx3->snk;
    // ports are integers.
    const json& lc = low.at("connections");
    bool x1_xx3 = false, xx3_snk = false, has_x2 = false, has_thr = false;
    for (const auto& c : lc) {
        assert(c[1].is_number_integer() && c[3].is_number_integer());
        if (c[0] == "x1" && c[2] == "xx3") x1_xx3 = true;
        if (c[0] == "xx3" && c[2] == "snk") xx3_snk = true;
        if (c[0] == "x2" || c[2] == "x2") has_x2 = true;
        if (c[0] == "thr" || c[2] == "thr") has_thr = true;
    }
    assert(x1_xx3 && xx3_snk && !has_x2 && !has_thr);

    std::cout << "grc_test: parser + lowering OK\n";
    return 0;
}
