#pragma once

#include "browser_file_sink.hpp"
#include "sigmf_tags.hpp"

#include <gnuradio/tags.h>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

// SigMF Sink: a browser file sink that also writes the .sigmf-meta beside the
// .sigmf-data, assembled from the flowgraph's own stream tags.
//
// The split is deliberate. BrowserFileSink owns everything about getting bytes
// out of WASM and into a file; this class owns nothing but the metadata, so the
// two concerns can be read -- and changed -- separately. The tag-to-metadata
// mapping itself is in sigmf_tags.hpp, shared with the source direction.
//
// block_executor constructs and destroys itself on the block's own scheduler
// thread, so start(), every work() and stop() run there in sequence: the
// accumulated metadata needs no lock.
class SigmfSink : public BrowserFileSink
{
public:
    using sptr = std::shared_ptr<SigmfSink>;

    static sptr make(std::size_t item_size,
                     const std::string& path,
                     const std::string& datatype,
                     double sample_rate,
                     double center_freq,
                     const std::string& author,
                     const std::string& description,
                     const std::string& hw_info,
                     bool annotate_tags)
    {
        return sptr(new SigmfSink(item_size,
                                  path,
                                  datatype,
                                  sample_rate,
                                  center_freq,
                                  author,
                                  description,
                                  hw_info,
                                  annotate_tags));
    }

protected:
    void on_written(std::uint64_t item_start, int count) override
    {
        if (!d_annotate_tags)
            return;
        std::vector<gr::tag_t> tags;
        get_tags_in_range(tags,
                          0,
                          item_start,
                          item_start + static_cast<std::uint64_t>(count));
        for (const auto& tag : tags)
            d_meta.add_tag(tag.offset, tag.key, tag.value);
    }

    std::string finish_payload() override
    {
        d_meta.set_sample_count(items_written());
        if (d_meta.overflowed())
            d_logger->error(
                "SigMF Sink: more than {} annotations; the rest were dropped",
                sigmf::MetaBuilder::MAX_ANNOTATIONS);
        return d_meta.document();
    }

private:
    SigmfSink(std::size_t item_size,
              const std::string& path,
              const std::string& datatype,
              double sample_rate,
              double center_freq,
              const std::string& author,
              const std::string& description,
              const std::string& hw_info,
              bool annotate_tags)
        : BrowserFileSink("sigmf_sink", item_size, path),
          d_meta(datatype, sample_rate, center_freq, author, description, hw_info),
          d_annotate_tags(annotate_tags)
    {
    }

    sigmf::MetaBuilder d_meta;
    bool d_annotate_tags;
};
