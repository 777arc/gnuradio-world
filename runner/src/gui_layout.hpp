// Where each GUI widget goes in the runner window.
//
// The flowgraph's one GUI Layout block (blocks/grc/wasm_gui_layout.block.yml)
// carries a grid spec: the window is `columns` wide, every row is `row_height`
// pixels tall, and each widget occupies a tile at some (col, row) spanning some
// (w, h) of those units. runner.cpp renders it as a QGridLayout, so the whole
// arrangement stretches with the browser tab -- columns share the width equally
// and rows share the height.
//
// This side is a pure *renderer* of a spec. Everything that edits one -- the
// drag-and-drop designer in the Properties dialog, the Arrange overlay over a
// running flowgraph -- lives in editor/src/gui-layout.ts, so there is exactly
// one implementation of the packing rules and it is the one with tests. What
// arrives here is therefore assumed already packed; the only correction made
// below is clamping a tile into the grid, so a hand-edited .grc cannot place a
// widget somewhere no resize will ever reveal. Overlap is left alone: two tiles
// on top of each other is visible, self-explanatory, and undone by dragging.
//
// Qt-free and GNU-Radio-free so the parsing can be reasoned about (and compiled)
// on its own; runner.cpp holds the QGridLayout construction.
#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <map>
#include <string>

namespace gui_layout {

// Fallbacks matching the block's own parameter defaults. A flowgraph saved
// before the GUI Layout block existed has no spec at all and gets the plain
// vertical stack instead, which is what `Spec::present` distinguishes.
constexpr int kDefaultColumns = 12;
constexpr int kDefaultRowHeight = 60;
// A window narrower than its column count would give each column under a pixel.
constexpr int kMaxColumns = 48;
// Default heights for a widget the spec says nothing about, in rows. A control
// is a slider or a button; a plot needs enough rows to be readable at all.
// CONTROL_ROWS and SINK_ROWS in editor/src/gui-layout.ts are the same two
// numbers, and they have to stay the same two: the editor lays an unarranged
// flowgraph out for its preview and the runner lays out the window, and a
// disagreement shows up as a preview that does not match what runs.
constexpr int kControlRows = 1;
constexpr int kSinkRows = 4;

struct Tile {
    int col = 0;
    int row = 0;
    int w = 1;
    int h = 1;
};

struct Spec {
    bool present = false;          // false: no GUI Layout block, stack vertically
    int columns = kDefaultColumns;
    int row_height = kDefaultRowHeight;
    std::map<std::string, Tile> tiles;   // by block name
};

// The spec for this run, filed by the GUI Layout block's factory before any
// block is built (the pre-pass run_now() uses for constellations and tag
// objects) and read once the widgets exist. A function-local static in an inline
// function is one object per module, which is fine because both ends -- the
// factory in registry.cpp and the layout pass in runner.cpp -- are in the main
// module. No side module has a GUI widget to place.
inline Spec& runtime_spec()
{
    static Spec spec;
    return spec;
}

// Clamp a tile into a `columns`-wide grid. A tile wider than the grid is
// narrowed rather than moved, so a spec written for 12 columns still fills the
// width when the block is later set to 8.
inline Tile clamp(Tile tile, int columns)
{
    tile.w = std::max(1, std::min(tile.w, columns));
    tile.h = std::max(1, tile.h);
    tile.col = std::max(0, std::min(tile.col, columns - tile.w));
    tile.row = std::max(0, tile.row);
    return tile;
}

// Parse the block's `layout` parameter: an object of
// `"block name": [col, row, w, h]`. Anything malformed is dropped rather than
// thrown on -- a spec is cosmetic, and refusing to run a working flowgraph over
// a bad tile would be the wrong trade. A widget whose tile is missing is placed
// full-width under the rest by the caller, so a dropped entry costs its widget
// its position and nothing else.
inline Spec parse(const std::string& text, int columns, int row_height)
{
    Spec spec;
    spec.present = true;
    spec.columns = std::max(1, std::min(columns, kMaxColumns));
    spec.row_height = std::max(1, row_height);
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse(text);
    } catch (const std::exception&) {
        return spec;
    }
    if (!parsed.is_object())
        return spec;
    for (const auto& entry : parsed.items()) {
        const auto& value = entry.value();
        if (!value.is_array() || value.size() != 4)
            continue;
        if (!std::all_of(value.begin(), value.end(),
                         [](const nlohmann::json& n) { return n.is_number(); }))
            continue;
        spec.tiles[entry.key()] = clamp(
            Tile{ value[0].get<int>(), value[1].get<int>(),
                  value[2].get<int>(), value[3].get<int>() },
            spec.columns);
    }
    return spec;
}

// One past the last row any tile occupies: where a widget with no tile of its
// own starts, so adding a sink to an arranged flowgraph never hides it behind
// one that was already placed.
inline int rows_used(const Spec& spec)
{
    int rows = 0;
    for (const auto& [name, tile] : spec.tiles)
        rows = std::max(rows, tile.row + tile.h);
    return rows;
}

} // namespace gui_layout
