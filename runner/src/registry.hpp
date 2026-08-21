// Block-factory registry for the JSON-driven flowgraph runner.
// Maps a GRC block id (e.g. "analog_sig_source_x") to a factory that constructs
// the block from a JSON params object. GUI sink blocks also return their QWidget.
#pragma once
#include <nlohmann/json.hpp>
#include <gnuradio/basic_block.h>
#include <functional>
#include <map>
#include <string>

class QWidget;

struct BuiltBlock {
    gr::basic_block_sptr block;
    QWidget* widget = nullptr;  // non-null for GUI sinks and controls

    // Numeric GRC parameters that can be changed while the graph is running.
    // Live QT GUI variable controls bind to these by parameter name.
    std::map<std::string, std::function<void(double)>> numeric_setters;

    // Variable controls have no GNU Radio block. Instead they publish their
    // initial value and accept subscribers which are called on user changes.
    bool is_variable = false;
    double variable_value = 0.0;
    std::function<void(std::function<void(double)>)> subscribe;
};

using Factory = std::function<BuiltBlock(const nlohmann::json& params)>;

// Direct C++ blocks are added by generated_registry.cpp. Hand-written entries in
// registry.cpp override generated entries where the WASM UI needs custom widget
// handling or richer live callbacks.
const std::map<std::string, Factory>& block_registry();

// Per-run typed objects (currently GRC constellation variables) are created
// before stream blocks and retained by the custom hierarchy factories.
void clear_runtime_objects();

// Core (always-linked) blocks: blocks/analog/fft/filter. Deferred category blocks
// register themselves via wasm_registry_add() when their side module is dlopen'd.
void register_generated_blocks(std::map<std::string, Factory>& registry);

// ---- JavaScript blocks (docs/js-blocks.md) --------------------------------
// Repo JS blocks, from generated_js_blocks.cpp: one generic factory bound to each
// `flags: [js]` block id. Adding one needs no relink of anything but this table.
void register_generated_js_blocks(std::map<std::string, Factory>& registry);
void register_js_block(std::map<std::string, Factory>& registry, const std::string& block_id);
// Which repo JS block ids the runner knows about, so runner.cpp can ask
// runner.html to fetch just the ones a flowgraph actually uses.
const std::map<std::string, std::string>& block_js_map();
// The fetched text for one of them, installed before any block is built.
void set_js_block_source(const std::string& block_id, const std::string& source);

// Baked into the main module by generated_modules.cpp. block_module_map() maps a
// GRC block id to the deferred category module that must be loaded before it can be
// built (core blocks are absent). module_deps() gives inter-module load order.
#include <vector>
const std::map<std::string, std::string>& block_module_map();
const std::map<std::string, std::vector<std::string>>& module_deps();
