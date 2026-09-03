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
-   name: challenge_0
    id: wasm_challenge
    parameters:
        challenge_id: challenge_0
        criteria: '[{"kind": "ran", "goal": "Run it"}]'
    states:
        coordinate: [50, 650]
        rotation: 0
        state: enabled
-   name: x1
    id: analog_sig_source_x
    parameters:
        samp_rate: rate
        frequency: freq
        waveform: analog.GR_COS_WAVE
        minoutbuf: '256'
        maxoutbuf: '1024'
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
    assert(g.at("blocks").is_array() && g["blocks"].size() == 9);
    assert(g.at("connections").size() == 4);
    assert(g["options"]["parameters"]["id"] == "t");
    assert(g["blocks"][0]["states"]["coordinate"] == json::array({ 50, 400 }));
    // Quoted numerics parse back as strings; the connection ports too.
    assert(g["blocks"][0]["parameters"]["value"] == "1500");
    assert(g["connections"][0][1] == "0");

    // A '#' inside a quoted scalar is content, not a comment: an Embedded Python
    // Block's source is one double-quoted line with escaped newlines, carrying
    // its own Python comments. A real trailing comment is still stripped.
    json q = grc_yaml::parse(
        "code: \"class blk(gr.sync_block):  # other bases\\n    pass\\n\"  # trailing\n"
        "quoted: 'it''s # not a comment'\n"
        "plain: 5  # five\n");
    assert(q["code"] == "class blk(gr.sync_block):  # other bases\n    pass\n");
    assert(q["quoted"] == "it's # not a comment");
    assert(q["plain"] == 5);

    // The GUI Layout block's grid is JSON inside a single-quoted scalar, so it
    // is full of characters YAML cares about: `{`, `"`, `,`, `[`. It has to come
    // back as the one string gui_layout::parse() then reads -- if the flow
    // handling ever claimed it instead, every arranged flowgraph would silently
    // fall back to a vertical stack. See docs/gui-layout.md.
    json layout = grc_yaml::parse(
        "layout: '{\"scope\":[0,0,6,4],\"freq_ctl\":[6,0,6,1]}'\n"
        "columns: '12'\n");
    assert(layout["layout"] == "{\"scope\":[0,0,6,4],\"freq_ctl\":[6,0,6,1]}");
    assert(layout["columns"] == "12");

    // ---- lowering ----
    json low = grc_lower::lower(g);
    const json& lb = low.at("blocks");
    // Dropped: options (not a block), disabled x2, bypassed thr, plain variable
    // rate, note_0 (an editor-only canvas annotation) and challenge_0 (an
    // editor-only statement of a challenge's success criteria). Neither of the
    // last two has a GNU Radio block behind it, so neither may reach the
    // factory registry.
    // Kept: freq (control), x1, xx3, snk.
    assert(lb.size() == 4);
    assert(find_block(lb, "freq") && find_block(lb, "x1") &&
           find_block(lb, "xx3") && find_block(lb, "snk"));
    assert(find_block(lb, "x2") == nullptr && find_block(lb, "thr") == nullptr &&
           find_block(lb, "rate") == nullptr && find_block(lb, "note_0") == nullptr &&
           find_block(lb, "challenge_0") == nullptr);

    // Plain variable `rate` is inlined as a number; control ref `freq` is kept.
    const json* x1 = find_block(lb, "x1");
    assert(x1->at("params").at("samp_rate") == 32000);   // inlined variable -> number
    assert(x1->at("params").at("frequency") == "freq");  // control ref preserved
    assert(x1->at("params").at("waveform") == "analog.GR_COS_WAVE");
    assert(x1->at("params").at("minoutbuf") == 256);
    assert(x1->at("params").at("maxoutbuf") == 1024);
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

    // A text parameter survives lowering as text even when it reads as a
    // number. USB-radio device serials are the case: coerce_numeric would turn
    // "00000001" into the integer 1, which loses the leading zeros and means
    // the serial never matches real hardware again. See is_text_param() in
    // grc_lower.hpp.
    {
        const char* rtl_doc =
            "options:\n"
            "    parameters: {id: rtl_text}\n"
            "blocks:\n"
            "-   name: rtl\n"
            "    id: wasm_rtlsdr_source\n"
            "    parameters:\n"
            "        device: '00000001'\n"
            "        samp_rate: '2048000'\n"
            "    states: {coordinate: [0, 0], rotation: 0, state: enabled}\n"
            "-   name: pluto_rx\n"
            "    id: wasm_plutosdr_source\n"
            "    parameters:\n"
            "        device: '00104242'\n"
            "    states: {coordinate: [0, 0], rotation: 0, state: enabled}\n"
            "-   name: pluto_tx\n"
            "    id: wasm_plutosdr_sink\n"
            "    parameters:\n"
            "        device: '00009999'\n"
            "    states: {coordinate: [0, 0], rotation: 0, state: enabled}\n"
            "-   name: other\n"
            "    id: blocks_null_sink\n"
            "    parameters:\n"
            "        device: '42'\n"
            "        serial: '00000001'\n"
            "    states: {coordinate: [0, 0], rotation: 0, state: enabled}\n"
            "connections: []\n";
        const json rtl_low = grc_lower::lower(grc_yaml::parse(rtl_doc));
        const json* rtl = nullptr;
        const json* pluto_rx = nullptr;
        const json* pluto_tx = nullptr;
        const json* other = nullptr;
        for (const auto& b : rtl_low.at("blocks")) {
            if (b.at("name") == "rtl") rtl = &b;
            if (b.at("name") == "pluto_rx") pluto_rx = &b;
            if (b.at("name") == "pluto_tx") pluto_tx = &b;
            if (b.at("name") == "other") other = &b;
        }
        assert(rtl && pluto_rx && pluto_tx && other);
        assert(rtl->at("params").at("device").is_string());
        assert(rtl->at("params").at("device") == "00000001");
        assert(pluto_rx->at("params").at("device") == "00104242");
        assert(pluto_tx->at("params").at("device") == "00009999");
        // Still coerced for every other numeric param on the same block...
        assert(rtl->at("params").at("samp_rate").is_number());
        // ...and the is_text_param exception is keyed on the block id, not on
        // the parameter name alone: `device` on a block that is not a radio is
        // an ordinary parameter and still coerces.
        assert(other->at("params").at("device").is_number());
        assert(other->at("params").at("device") == 42);
        // Beyond that named exception, coerce_numeric only converts an integer
        // that is the whole meaning of its text. "00000001" is not the integer
        // 1 -- to_string(1) does not give it back -- so it stays text wherever
        // it appears, without needing a block id on a list first. This is what
        // stops a call sign, a label or an unlisted device's serial from
        // silently losing its leading zeros.
        assert(other->at("params").at("serial").is_string());
        assert(other->at("params").at("serial") == "00000001");
    }

    // Flow sequences nest. Splitting on top-level commas without tracking
    // bracket depth turned a matrix parameter into a list of strings ("[1",
    // "2]", ...) with nothing to show for it, so a hand-written .grc carrying
    // an int_matrix computed something else entirely.
    {
        const char* nested =
            "options:\n"
            "    parameters: {id: nested}\n"
            "blocks:\n"
            "-   name: m\n"
            "    id: blocks_null_sink\n"
            "    parameters:\n"
            "        matrix: [[1, 2], [3, 4]]\n"
            "        mixed: [1, [2, 3], 'a, b']\n"
            "    states: {coordinate: [0, 0], rotation: 0, state: enabled}\n"
            "connections: []\n";
        const json low = grc_lower::lower(grc_yaml::parse(nested));
        const json& params = low.at("blocks").at(0).at("params");
        const json& matrix = params.at("matrix");
        assert(matrix.is_array() && matrix.size() == 2);
        assert(matrix[0].is_array() && matrix[0].size() == 2);
        assert(matrix[0][0] == 1 && matrix[0][1] == 2);
        assert(matrix[1][0] == 3 && matrix[1][1] == 4);
        // A quoted comma is still one element, and a nested sequence beside a
        // scalar does not disturb it.
        const json& mixed = params.at("mixed");
        assert(mixed.size() == 3);
        assert(mixed[0] == 1);
        assert(mixed[1].is_array() && mixed[1].size() == 2);
        assert(mixed[2] == "a, b");
    }

    // The browser-only `scheduler` key on the options block. Two spellings have
    // to work: the top-level `options:` GRC writes, and an `options` entry under
    // `blocks:`, which is how a hand-written flowgraph often carries it.
    {
        const char* top_level =
            "options:\n"
            "    parameters:\n"
            "        id: t\n"
            "        scheduler: sts\n"
            "    states:\n"
            "        coordinate: [8, 8]\n"
            "        rotation: 0\n"
            "        state: enabled\n"
            "blocks:\n"
            "-   name: snk\n"
            "    id: blocks_null_sink\n"
            "    parameters:\n"
            "        vlen: '1'\n"
            "    states:\n"
            "        coordinate: [0, 0]\n"
            "        rotation: 0\n"
            "        state: enabled\n"
            "connections: []\n";
        assert(grc_lower::lower(grc_yaml::parse(top_level)).at("scheduler") == "sts");

        const char* in_blocks =
            "blocks:\n"
            "-   name: options\n"
            "    id: options\n"
            "    parameters:\n"
            "        id: t\n"
            "        scheduler: sts\n"
            "    states:\n"
            "        coordinate: [8, 8]\n"
            "        rotation: 0\n"
            "        state: enabled\n"
            "-   name: snk\n"
            "    id: blocks_null_sink\n"
            "    parameters:\n"
            "        vlen: '1'\n"
            "    states:\n"
            "        coordinate: [0, 0]\n"
            "        rotation: 0\n"
            "        state: enabled\n"
            "connections: []\n";
        const json in_blocks_low = grc_lower::lower(grc_yaml::parse(in_blocks));
        assert(in_blocks_low.at("scheduler") == "sts");
        // ... and the options block itself never reaches the registry either way.
        assert(in_blocks_low.at("blocks").size() == 1);

        // Absent means "the runner's default", not an error.
        const char* absent =
            "options:\n"
            "    parameters:\n"
            "        id: t\n"
            "    states:\n"
            "        coordinate: [8, 8]\n"
            "        rotation: 0\n"
            "        state: enabled\n"
            "blocks: []\n"
            "connections: []\n";
        assert(grc_lower::lower(grc_yaml::parse(absent)).at("scheduler") == "");
    }

    std::cout << "grc_test: parser + lowering OK\n";
    return 0;
}
