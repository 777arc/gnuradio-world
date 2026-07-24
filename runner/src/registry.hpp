// Block-factory registry for the JSON-driven flowgraph runner.
// Maps a GRC block id (e.g. "analog_sig_source_x") to a factory that constructs
// the block from a JSON params object. GUI sink blocks also return their QWidget.
#pragma once
#include "json.hpp"
#include <gnuradio/basic_block.h>
#include <functional>
#include <map>
#include <string>

class QWidget;

struct BuiltBlock {
    gr::basic_block_sptr block;
    QWidget* widget = nullptr;  // non-null for GUI sinks and controls

    // Numeric GRC parameters that can be changed while the graph is running.
    // QT GUI Range variables bind to these by parameter name.
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

// Core (always-linked) blocks: blocks/analog/fft/filter. Deferred category blocks
// register themselves via wasm_registry_add() when their side module is dlopen'd.
void register_generated_blocks(std::map<std::string, Factory>& registry);

// Baked into the main module by generated_modules.cpp. block_module_map() maps a
// GRC block id to the deferred category module that must be loaded before it can be
// built (core blocks are absent). module_deps() gives inter-module load order.
#include <vector>
const std::map<std::string, std::string>& block_module_map();
const std::map<std::string, std::vector<std::string>>& module_deps();
