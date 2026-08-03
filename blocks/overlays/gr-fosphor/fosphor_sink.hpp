#pragma once

// Browser CPU fallback for gr-fosphor's embedded Qt sink. Upstream couples the
// sink to OpenCL and desktop OpenGL. The WASM runner already carries Qt6 ports
// of GNU Radio's
// spectrum and waterfall sinks, so this hierarchy fans the native complex input
// into those two processors and presents their widgets as one vertically split
// display. It intentionally takes plain C++ arguments: JSON decoding remains in
// runner/src/registry.cpp with the other factories.

#include <gnuradio/fft/window.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/qtgui/freq_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_c.h>
#include <gnuradio/qtgui/displayform.h>

#include <QShortcut>
#include <QSplitter>
#include <QVBoxLayout>
#include <QWidget>

#include <algorithm>
#include <cmath>
#include <functional>
#include <iterator>
#include <memory>
#include <string>

class FosphorSinkWasm : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FosphorSinkWasm>;

    static sptr make(const std::string& block_name,
                     gr::fft::window::win_type window,
                     double center_frequency,
                     double frequency_span)
    {
        return gnuradio::make_block_sptr<FosphorSinkWasm>(
            block_name, window, center_frequency, frequency_span);
    }

    FosphorSinkWasm(const std::string& block_name,
                    gr::fft::window::win_type window,
                    double center_frequency,
                    double frequency_span)
        : gr::hier_block2(block_name,
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(0, 0, 0)),
          d_spectrum(gr::qtgui::freq_sink_c::make(
              1024, window, center_frequency, frequency_span,
              "Fosphor Spectrum", 1)),
          d_waterfall(gr::qtgui::waterfall_sink_c::make(
              1024, window, center_frequency, frequency_span,
              "Fosphor Waterfall", 1)),
          d_widget(new QWidget),
          d_center_frequency(center_frequency),
          d_frequency_span(frequency_span)
    {
        d_spectrum->set_fft_average(0.2F);
        d_spectrum->set_line_color(0, "#6cff5c");
        d_spectrum->set_line_width(0, 2);
        d_spectrum->disable_legend();
        d_spectrum->enable_grid(true);

        d_waterfall->set_fft_average(0.2F);
        d_waterfall->set_color_map(0, 0);
        d_waterfall->disable_legend();

        auto* layout = new QVBoxLayout(d_widget);
        layout->setContentsMargins(0, 0, 0, 0);
        d_splitter = new QSplitter(Qt::Vertical, d_widget);
        d_splitter->addWidget(d_waterfall->qwidget());
        d_splitter->addWidget(d_spectrum->qwidget());
        d_splitter->setStretchFactor(0, 2);
        d_splitter->setStretchFactor(1, 1);
        layout->addWidget(d_splitter);
        d_widget->setMinimumSize(640, 560);
        d_widget->setFocusPolicy(Qt::StrongFocus);

        apply_power_range();
        apply_split_ratio();
        install_shortcuts();

        message_port_register_hier_out(pmt::mp("freq"));
        msg_connect(d_spectrum, "freq", self(), "freq");
        msg_connect(d_waterfall, "freq", self(), "freq");
        connect(self(), 0, d_spectrum, 0);
        connect(self(), 0, d_waterfall, 0);
    }

    QWidget* qwidget() const { return d_widget; }

    void set_frequency_range(double center_frequency, double frequency_span)
    {
        d_center_frequency = center_frequency;
        d_frequency_span = frequency_span;
        apply_frequency_range();
    }

    void set_fft_window(gr::fft::window::win_type window)
    {
        d_spectrum->set_fft_window(window);
        d_waterfall->set_fft_window(window);
    }

private:
    static constexpr int DB_PER_DIV[] = { 1, 2, 5, 10, 20 };

    void add_shortcut(Qt::Key key, std::function<void()> action)
    {
        auto* shortcut = new QShortcut(QKeySequence(key), d_widget);
        shortcut->setContext(Qt::WidgetWithChildrenShortcut);
        QObject::connect(shortcut,
                         &QShortcut::activated,
                         d_widget,
                         std::move(action));
    }

    void install_shortcuts()
    {
        // Match upstream QGLSurface::keyPressEvent exactly. The browser zoom
        // uses the same center/width state but applies it to both embedded plots
        // instead of opening fosphor's secondary OpenGL render viewport.
        add_shortcut(Qt::Key_Up, [this] { adjust_reference(-1); });
        add_shortcut(Qt::Key_Down, [this] { adjust_reference(1); });
        add_shortcut(Qt::Key_Left, [this] { adjust_db_per_div(-1); });
        add_shortcut(Qt::Key_Right, [this] { adjust_db_per_div(1); });
        add_shortcut(Qt::Key_Z, [this] {
            d_zoom_enabled = !d_zoom_enabled;
            apply_frequency_range();
        });
        add_shortcut(Qt::Key_W, [this] { adjust_zoom_width(2.0); });
        add_shortcut(Qt::Key_S, [this] { adjust_zoom_width(0.5); });
        add_shortcut(Qt::Key_D, [this] { adjust_zoom_center(1.0); });
        add_shortcut(Qt::Key_A, [this] { adjust_zoom_center(-1.0); });
        add_shortcut(Qt::Key_Q, [this] { adjust_split_ratio(0.05); });
        add_shortcut(Qt::Key_E, [this] { adjust_split_ratio(-0.05); });
        add_shortcut(Qt::Key_Space, [this] { toggle_freeze(); });
    }

    void adjust_reference(int direction)
    {
        d_db_reference += direction * DB_PER_DIV[d_db_per_div_index];
        apply_power_range();
    }

    void adjust_db_per_div(int direction)
    {
        d_db_per_div_index = std::clamp(
            d_db_per_div_index + direction, 0,
            static_cast<int>(std::size(DB_PER_DIV)) - 1);
        apply_power_range();
    }

    void apply_power_range()
    {
        const double maximum = static_cast<double>(d_db_reference);
        const double minimum =
            maximum - 10.0 * DB_PER_DIV[d_db_per_div_index];
        d_spectrum->set_y_axis(minimum, maximum);
        d_waterfall->set_intensity_range(minimum, maximum);
    }

    void adjust_zoom_width(double factor)
    {
        if (!d_zoom_enabled)
            return;
        d_zoom_width = std::clamp(d_zoom_width * factor, 1.0 / 1024.0, 1.0);
        d_zoom_center = std::clamp(
            d_zoom_center, d_zoom_width / 2.0, 1.0 - d_zoom_width / 2.0);
        apply_frequency_range();
    }

    void adjust_zoom_center(double direction)
    {
        if (!d_zoom_enabled)
            return;
        d_zoom_center += direction * d_zoom_width / 8.0;
        d_zoom_center = std::clamp(
            d_zoom_center, d_zoom_width / 2.0, 1.0 - d_zoom_width / 2.0);
        apply_frequency_range();
    }

    void apply_frequency_range()
    {
        double center = d_center_frequency;
        double span = d_frequency_span;
        if (d_zoom_enabled) {
            center += (d_zoom_center - 0.5) * d_frequency_span;
            span *= d_zoom_width;
        }
        d_spectrum->set_frequency_range(center, span);
        d_waterfall->set_frequency_range(center, span);
    }

    void adjust_split_ratio(double amount)
    {
        d_split_ratio = std::clamp(d_split_ratio + amount, 0.2, 0.8);
        apply_split_ratio();
    }

    void apply_split_ratio()
    {
        constexpr int SCALE = 1000;
        d_splitter->setSizes({ static_cast<int>(std::lround(
                                   SCALE * (1.0 - d_split_ratio))),
                               static_cast<int>(std::lround(
                                   SCALE * d_split_ratio)) });
    }

    void toggle_freeze()
    {
        d_frozen = !d_frozen;
        if (auto* form = qobject_cast<DisplayForm*>(d_spectrum->qwidget()))
            form->setStop(d_frozen);
        if (auto* form = qobject_cast<DisplayForm*>(d_waterfall->qwidget()))
            form->setStop(d_frozen);
    }

    gr::qtgui::freq_sink_c::sptr d_spectrum;
    gr::qtgui::waterfall_sink_c::sptr d_waterfall;
    QWidget* d_widget;
    QSplitter* d_splitter = nullptr;
    double d_center_frequency;
    double d_frequency_span;
    int d_db_reference = 0;
    int d_db_per_div_index = 3;
    bool d_zoom_enabled = false;
    double d_zoom_center = 0.5;
    double d_zoom_width = 0.2;
    double d_split_ratio = 0.35;
    bool d_frozen = false;
};
