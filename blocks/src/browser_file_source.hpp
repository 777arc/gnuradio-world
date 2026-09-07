#pragma once

#include "sigmf_tags.hpp"

#include <gnuradio/sync_block.h>
#include <pmt/pmt.h>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// A browser-backed replacement for gr::blocks::file_source. The browser keeps
// the selected File (or remote URL) outside WASM and a dedicated Web Worker
// reads bounded slices into this block's fixed-size shared-memory ring.
class BrowserFileSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<BrowserFileSource>;

    static sptr make(std::size_t item_size,
                     const std::string& path,
                     bool repeat,
                     std::uint64_t offset_items,
                     std::uint64_t length_items,
                     pmt::pmt_t begin_tag = pmt::PMT_NIL);

    ~BrowserFileSource() override;

    // Tags to emit as the file is read, at offsets counted from the first sample
    // of a pass. SigMF Source is what sets one: its recording's capture segments
    // and annotations become tags here rather than in a block of its own,
    // because everything else about reading the file is already this class's
    // job. Entries must be sorted by offset; runner/src/sigmf_meta.hpp builds
    // them that way. Call before start().
    void set_tag_plan(std::vector<sigmf::TagPlanEntry> plan);

    // How far into the file this source has read, for the progress widget the
    // factory attaches (blocks/src/file_progress_widget.hpp). Safe to call from
    // the Qt thread while work() runs on the block's own: the one counter it
    // moves is published through an atomic, and nothing here reads the ring or
    // the tag plan.
    struct Progress {
        std::uint64_t position = 0;  // items produced into the current pass
        std::uint64_t length = 0;    // items in one pass, i.e. the selection
        std::uint64_t offset = 0;    // items skipped before the selection
        std::uint64_t passes = 0;    // passes completed, for a Repeat source
        std::size_t item_size = 0;
    };
    Progress progress() const;
    const std::string& path() const { return d_path; }

    bool start() override;
    bool stop() override;
    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    BrowserFileSource(std::size_t item_size,
                      std::string path,
                      bool repeat,
                      std::uint64_t offset_items,
                      std::uint64_t length_items,
                      pmt::pmt_t begin_tag);

    enum State : std::int32_t {
        INITIAL = 0,
        RUNNING = 1,
        EOF_REACHED = 2,
        ERROR = 3,
        CANCELLED = 4,
    };

    struct alignas(4) Control {
        std::int32_t read_pos = 0;   // item index within the ring
        std::int32_t write_pos = 0;  // item index within the ring
        std::int32_t state = INITIAL;
        std::int32_t error_length = 0;
    };

    static constexpr std::size_t RING_BYTES = 16 * 1024 * 1024;
    static constexpr std::size_t ERROR_BYTES = 512;

    std::size_t d_item_size;
    std::string d_path;
    bool d_repeat;
    std::uint64_t d_offset_items;
    std::uint64_t d_length_items;
    std::uint64_t d_items_into_pass = 0;
    std::uint64_t d_repeat_count = 0;
    // Items produced since start(), published for progress(). One counter that
    // only ever climbs, rather than the position/pass pair the display wants:
    // work() resets the position at every loop, and a reader that caught the
    // two halves of that either side of the reset would see the file jump
    // backwards. Position and pass number divide back out of this.
    std::atomic<std::uint64_t> d_published_produced{ 0 };
    pmt::pmt_t d_begin_tag;
    pmt::pmt_t d_tag_source;
    std::vector<sigmf::TagPlanEntry> d_tag_plan;
    std::size_t d_tag_cursor = 0;   // next plan entry not yet emitted this pass

    std::size_t d_capacity_items;
    std::vector<unsigned char> d_ring;
    Control d_control;
    char d_error[ERROR_BYTES]{};
    int d_reader_id = 0;

    std::int32_t load(const std::int32_t* value) const;
    void store(std::int32_t* value, std::int32_t next);
    void wake(std::int32_t* value);
    std::string reader_error() const;
};
