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
    QWidget* widget = nullptr;  // non-null for GUI sinks
};

using Factory = std::function<BuiltBlock(const nlohmann::json& params)>;

// The MVP registry. Phase B will auto-generate a larger one from block .yml files.
const std::map<std::string, Factory>& block_registry();
