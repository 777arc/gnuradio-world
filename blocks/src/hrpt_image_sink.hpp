#pragma once

// Runner-only: turns a synced NOAA HRPT minor-frame word stream (as produced
// by gr-hrpt's noaa_hrpt_deframer) into a live scrolling grayscale image, one
// AVHRR scan line per minor frame. gr-hrpt's own noaa_hrpt_decoder does not do
// this -- it only parses minor-frame timestamps/telemetry -- and upstream
// flowgraphs instead write the deframer's raw words to a File Sink and hand
// the file to an external tool (MetFy3x, HRPT Reader, weathersat). The
// browser has no such file-handoff (see docs/blocks.md's "a block that prints
// text has somewhere to print it" for the same trade under wasm_text_sink),
// so this sink does the channel de-interleave and display itself.
//
// Minor-frame layout: 11090 10-bit words, 6 sync words + 1 ID word, then AVHRR
// video as 2048 groups of 5 interleaved channel words starting at word 751
// (1-indexed) -- confirmed against a from-scratch NOAA HRPT demux
// (AlexandreRouma/qdsp's dsp/noaa/hrpt.h: `HRPTReadWord(750 + 5*i + channel)`
// with a 0-indexed word offset), not gr-hrpt's own code, which never gets that
// far. Video Start Word/Words per Minor Frame are exposed as parameters rather
// than hard-coded so the same sink can be pointed at a differently-framed
// input if one ever needs it.

#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>

#include <QGroupBox>
#include <QImage>
#include <QLabel>
#include <QPixmap>
#include <QPointer>
#include <QScrollArea>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <vector>

class HrptImageSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<HrptImageSinkWasm>;

    static sptr make(const std::string& name,
                      int channel,
                      int image_width,
                      int words_per_line,
                      int video_start,
                      bool invert,
                      int max_lines)
    {
        return gnuradio::make_block_sptr<HrptImageSinkWasm>(
            name, channel, image_width, words_per_line, video_start, invert,
            max_lines);
    }

    HrptImageSinkWasm(const std::string& name,
                       int channel,
                       int image_width,
                       int words_per_line,
                       int video_start,
                       bool invert,
                       int max_lines)
        : gr::sync_block("hrpt_image_sink",
                         gr::io_signature::make(1, 1, sizeof(std::int16_t)),
                         gr::io_signature::make(0, 0, 0)),
          d_channel(std::clamp(channel, 1, 5) - 1),
          d_image_width(std::max(image_width, 1)),
          d_words_per_line(std::max(words_per_line, 1)),
          // Stored 0-indexed; the yaml parameter is 1-indexed to match the
          // "word 751" convention the rest of the HRPT literature uses.
          d_video_start(std::max(video_start - 1, 0)),
          d_invert(invert),
          d_max_lines(std::max(max_lines, 1)),
          d_image(d_image_width, d_max_lines, QImage::Format_Grayscale8),
          d_widget(new QGroupBox(QString::fromStdString(name)))
    {
        d_image.fill(0);

        auto* layout = new QVBoxLayout(d_widget);
        layout->setContentsMargins(4, 4, 4, 4);
        auto* scroll = new QScrollArea(d_widget);
        scroll->setWidgetResizable(false);
        scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        d_label = new QLabel;
        d_label->setFixedSize(kDisplayWidth, 1);
        scroll->setWidget(d_label);
        layout->addWidget(scroll);
        d_widget->setMinimumSize(kDisplayWidth + 24, 320);

        // Parented to the widget, so it lives and dies on the GUI thread. The
        // GR-thread work() only ever touches d_image/d_lines_written under
        // d_mutex; repaint() takes a deep copy under the same lock and does
        // the (possibly slow) rescale outside it.
        auto* timer = new QTimer(d_widget);
        QObject::connect(timer, &QTimer::timeout, d_widget, [this] { repaint(); });
        timer->start(250);
    }

    QWidget* qwidget() const { return d_widget; }

    int work(int noutput_items,
              gr_vector_const_void_star& input_items,
              gr_vector_void_star&) override
    {
        const auto* in = static_cast<const std::int16_t*>(input_items[0]);

        std::lock_guard<std::mutex> lock(d_mutex);
        for (int i = 0; i < noutput_items; ++i) {
            d_carry.push_back(in[i]);
            if (static_cast<int>(d_carry.size()) < d_words_per_line)
                continue;
            emit_line(d_carry);
            d_carry.clear();
        }
        return noutput_items;
    }

private:
    // Called with d_mutex held. Extracts this sink's channel out of one
    // completed minor frame and appends it as the image's newest row.
    void emit_line(const std::vector<std::int16_t>& frame)
    {
        std::vector<uint8_t> row(static_cast<std::size_t>(d_image_width));
        for (int i = 0; i < d_image_width; ++i) {
            const std::size_t idx = static_cast<std::size_t>(
                d_video_start + i * 5 + d_channel);
            int sample = idx < frame.size() ? (frame[idx] & 0x3FF) : 0;
            if (d_invert)
                sample = 0x3FF - sample;
            row[static_cast<std::size_t>(i)] =
                static_cast<uint8_t>((sample * 255) / 1023);
        }

        if (d_lines_written < d_max_lines) {
            std::memcpy(d_image.scanLine(d_lines_written), row.data(),
                       row.size());
            ++d_lines_written;
        }
        else {
            // Scroll the whole buffer up by one row and drop the row that
            // falls off the top -- the oldest line is always row 0, the
            // newest always the last, with no wraparound bookkeeping needed
            // at paint time.
            const int stride = d_image.bytesPerLine();
            std::memmove(d_image.scanLine(0), d_image.scanLine(1),
                         static_cast<std::size_t>(stride) *
                             static_cast<std::size_t>(d_max_lines - 1));
            std::memcpy(d_image.scanLine(d_max_lines - 1), row.data(),
                       row.size());
        }
        d_dirty = true;
    }

    void repaint()
    {
        QImage snapshot;
        int lines_written;
        {
            std::lock_guard<std::mutex> lock(d_mutex);
            if (!d_dirty)
                return;
            d_dirty = false;
            snapshot = d_image.copy();
            lines_written = d_lines_written;
        }
        if (lines_written <= 0)
            return;
        const QImage cropped = snapshot.copy(0, 0, d_image_width, lines_written);
        const int display_height = std::max(
            1, static_cast<int>((static_cast<qint64>(lines_written) * kDisplayWidth) /
                                 d_image_width));
        const QPixmap scaled = QPixmap::fromImage(cropped).scaled(
            kDisplayWidth, display_height, Qt::IgnoreAspectRatio,
            Qt::SmoothTransformation);
        d_label->setFixedSize(kDisplayWidth, display_height);
        d_label->setPixmap(scaled);
    }

    static constexpr int kDisplayWidth = 640;

    const int d_channel;
    const int d_image_width;
    const int d_words_per_line;
    const int d_video_start;
    const bool d_invert;
    const int d_max_lines;

    std::mutex d_mutex;
    std::vector<std::int16_t> d_carry;
    QImage d_image;
    int d_lines_written = 0;
    bool d_dirty = false;

    QGroupBox* d_widget;
    QPointer<QLabel> d_label;
};
