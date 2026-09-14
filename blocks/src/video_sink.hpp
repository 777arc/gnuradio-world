#pragma once

// Runner-only: a grayscale raster display, the browser's stand-in for
// gr-video-sdl's Video SDL Sink in its 1-channel mode. One input item is one
// pixel, Width items make a row and Height rows make a frame, scanned left to
// right and top to bottom -- exactly the item order gr-video-sdl's sink_s
// consumes. The first user is gr-tempest, whose Framing block emits
// Htotal x Vtotal luma floats per recovered video frame and whose upstream
// examples end in a Video SDL Sink; there is no SDL in a tab, so this draws
// through a QWidget instead.
//
// Two deliberate departures from the SDL sink: a value outside 0..255 is
// clipped where SDL's casts to unsigned char and wraps, since a Normalize Flow
// output that overshoots a little should not flash from white to black; and
// the frame is painted as it fills rather than only once complete, because at
// browser throughput a 30 MS/s tempest capture fills a 1344x806 frame over a
// noticeable fraction of a second and a picture that builds up row by row
// reads as progress where a blank tile reads as a stall.
//
// The GR-thread work() only ever touches d_pixels under d_mutex; the paint
// runs on the GUI thread from a QTimer parented to the widget, takes a copy
// under the same lock, and scales outside it.

#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>

#include <QGroupBox>
#include <QImage>
#include <QPainter>
#include <QPaintEvent>
#include <QPointer>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

class VideoSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<VideoSinkWasm>;

    enum class item_type { f32, s16, u8 };

    // display_width/display_height give the shape the frame is shown at (its
    // aspect ratio; the tile decides the size), as gr-video-sdl's do. 0 for
    // either means the input's own shape.
    static sptr make(const std::string& name,
                     item_type type,
                     int width,
                     int height,
                     int display_width,
                     int display_height)
    {
        return gnuradio::make_block_sptr<VideoSinkWasm>(
            name, type, width, height, display_width, display_height);
    }

    VideoSinkWasm(const std::string& name,
                  item_type type,
                  int width,
                  int height,
                  int display_width,
                  int display_height)
        : gr::sync_block("video_sink",
                         gr::io_signature::make(1, 1, item_size(type)),
                         gr::io_signature::make(0, 0, 0)),
          d_type(type),
          d_width(std::max(width, 1)),
          d_height(std::max(height, 1)),
          d_pixels(static_cast<std::size_t>(d_width) * d_height, 0),
          d_widget(new QGroupBox(QString::fromStdString(name)))
    {

        auto* layout = new QVBoxLayout(d_widget);
        layout->setContentsMargins(4, 4, 4, 4);
        d_canvas = new Canvas(d_widget,
                              QSize(display_width > 0 ? display_width : d_width,
                                    display_height > 0 ? display_height : d_height));
        layout->addWidget(d_canvas);
        d_widget->setMinimumSize(320, 240);

        // 25 fps is plenty for a picture that a GR thread fills far more
        // slowly than that; a tick with nothing new paints nothing.
        auto* timer = new QTimer(d_widget);
        QObject::connect(timer, &QTimer::timeout, d_widget, [this] { repaint(); });
        timer->start(40);
    }

    QWidget* qwidget() const { return d_widget; }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star&) override
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        switch (d_type) {
        case item_type::f32:
            consume_pixels(static_cast<const float*>(input_items[0]), noutput_items);
            break;
        case item_type::s16:
            consume_pixels(static_cast<const std::int16_t*>(input_items[0]),
                           noutput_items);
            break;
        case item_type::u8:
            consume_pixels(static_cast<const std::uint8_t*>(input_items[0]),
                           noutput_items);
            break;
        }
        return noutput_items;
    }

private:
    static std::size_t item_size(item_type type)
    {
        switch (type) {
        case item_type::f32:
            return sizeof(float);
        case item_type::s16:
            return sizeof(std::int16_t);
        case item_type::u8:
            return sizeof(std::uint8_t);
        }
        return sizeof(float);
    }

    static std::uint8_t luma(float v)
    {
        if (!(v > 0.0f)) // also catches NaN
            return 0;
        return v >= 255.0f ? 255 : static_cast<std::uint8_t>(std::lround(v));
    }
    static std::uint8_t luma(std::int16_t v)
    {
        return static_cast<std::uint8_t>(std::clamp<int>(v, 0, 255));
    }
    static std::uint8_t luma(std::uint8_t v) { return v; }

    // Called with d_mutex held. Writes items into the frame at the raster
    // position, wrapping to the top-left after the last pixel of a frame. The
    // frame is a plain byte array rather than a QImage: QImage::scanLine()
    // detaches on every call, which at one call per pixel made this sink the
    // slowest block in a 30 MS/s chain.
    template <typename T>
    void consume_pixels(const T* in, int n)
    {
        std::uint8_t* pixels = d_pixels.data();
        const std::size_t total = d_pixels.size();
        for (int i = 0; i < n; ++i) {
            pixels[d_pos] = luma(in[i]);
            if (++d_pos == total)
                d_pos = 0;
        }
        if (n > 0)
            d_dirty = true;
    }

    void repaint()
    {
        QImage snapshot;
        {
            std::lock_guard<std::mutex> lock(d_mutex);
            if (!d_dirty)
                return;
            d_dirty = false;
            // QImage over the bytes, then a deep copy so the paint owns it.
            snapshot = QImage(d_pixels.data(), d_width, d_height, d_width,
                              QImage::Format_Grayscale8).copy();
        }
        if (d_canvas)
            d_canvas->show_frame(snapshot);
    }

    // Paints the latest frame at the display shape, scaled to fit. A plain
    // QWidget subclass with no signals or slots, so it needs no moc pass.
    class Canvas : public QWidget
    {
    public:
        Canvas(QWidget* parent, QSize display_shape)
            : QWidget(parent), d_display_shape(display_shape)
        {
            setMinimumSize(160, 120);
            setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
        }

        void show_frame(const QImage& frame)
        {
            d_frame = frame;
            update();
        }

    protected:
        void paintEvent(QPaintEvent*) override
        {
            QPainter painter(this);
            painter.fillRect(rect(), Qt::black);
            if (d_frame.isNull())
                return;
            const QSize fitted = d_display_shape.scaled(size(), Qt::KeepAspectRatio);
            const QRect target((width() - fitted.width()) / 2,
                               (height() - fitted.height()) / 2,
                               fitted.width(),
                               fitted.height());
            painter.setRenderHint(QPainter::SmoothPixmapTransform, true);
            painter.drawImage(target, d_frame);
        }

    private:
        const QSize d_display_shape;
        QImage d_frame;
    };

    const item_type d_type;
    const int d_width;
    const int d_height;

    std::mutex d_mutex;
    std::vector<std::uint8_t> d_pixels;
    std::size_t d_pos = 0;
    bool d_dirty = false;

    QGroupBox* d_widget;
    QPointer<Canvas> d_canvas;
};
