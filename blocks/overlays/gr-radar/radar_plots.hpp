#pragma once

// Browser rebuilds of gr-radar's three Qt GUI sinks, the only blocks in the
// module that ever display an estimate. Upstream they are Qwt QWidgets
// declaring Q_OBJECT (gr-radar/lib/{time,scatter,spectrogram}_plot.*), and the
// runner build has no moc pass -- nor could the vendored sources compile as they
// stand, because they are written against Qwt 6.1's `QwtPlot::yLeft` axis
// constants and the sysroot's Qwt is 6.3, where those moved to `QwtAxis`.
//
// So each is rebuilt here against the Qwt already linked into the main module,
// with the two browser differences upstream has no reason to make:
//
//   * no Q_OBJECT. The only signal/slot connection upstream makes is the refresh
//     timer, and `QObject::connect(timer, &QTimer::timeout, widget, lambda)`
//     needs no meta-object on the receiving side.
//   * a mutex. The message handler and `work()` run on a GNU Radio thread while
//     the timer paints on the GUI thread; upstream passes a raw pointer between
//     the two and races. Under WASM pthreads that race is real, so the data
//     crosses under a lock -- the same split RdsPanelWasm uses.
//
// Their factories are the hand-written entries in runner/src/registry.cpp, and
// each declares `gui: true` in the metadata.yml beside this file so the editor
// gives it a tile in the GUI Layout grid.

#include <gnuradio/block.h>
#include <gnuradio/tagged_stream_block.h>
#include <pmt/pmt.h>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

class QWidget;
class QwtPlot;
class QwtPlotMarker;
class QwtPlotSpectrogram;
class QwtSymbol;

namespace radar_plots {

// One row of markers per refresh tick, so a tick can detach exactly what it drew
// `range_time` ago without touching the rest of the plot.
using MarkerRow = std::vector<QwtPlotMarker*>;

}  // namespace radar_plots

// gr-radar's "QT GUI Time Plot": one estimate key plotted against wall time,
// scrolling over a fixed window. Rebuild of gr-radar/lib/time_plot.cc.
class RadarTimePlotWasm : public gr::block
{
public:
    using sptr = std::shared_ptr<RadarTimePlotWasm>;

    static sptr make(int interval,
                     const std::string& label_y,
                     const std::vector<float>& axis_y,
                     float range_time,
                     const std::string& label);

    RadarTimePlotWasm(int interval,
                      const std::string& label_y,
                      const std::vector<float>& axis_y,
                      float range_time,
                      const std::string& label);

    QWidget* qwidget() const { return d_widget; }

private:
    void handle(const pmt::pmt_t& msg);
    void refresh();

    const std::string d_label_y;
    const int d_interval;
    const float d_range_time;

    QWidget* d_widget = nullptr;
    QwtPlot* d_plot = nullptr;
    QwtSymbol* d_symbol = nullptr;
    std::vector<radar_plots::MarkerRow> d_marker;
    int d_refresh_counter = 0;

    std::mutex d_mutex;
    std::vector<float> d_y;
    bool d_fresh = false;
};

// gr-radar's "QT GUI Scatter Plot": two estimate keys against each other, e.g.
// range over velocity. Rebuild of gr-radar/lib/scatter_plot.cc.
class RadarScatterPlotWasm : public gr::block
{
public:
    using sptr = std::shared_ptr<RadarScatterPlotWasm>;

    static sptr make(int interval,
                     const std::string& label_x,
                     const std::string& label_y,
                     const std::vector<float>& axis_x,
                     const std::vector<float>& axis_y,
                     const std::string& label);

    RadarScatterPlotWasm(int interval,
                         const std::string& label_x,
                         const std::string& label_y,
                         const std::vector<float>& axis_x,
                         const std::vector<float>& axis_y,
                         const std::string& label);

    QWidget* qwidget() const { return d_widget; }

private:
    void handle(const pmt::pmt_t& msg);
    void refresh();

    const std::string d_label_x;
    const std::string d_label_y;

    QWidget* d_widget = nullptr;
    QwtPlot* d_plot = nullptr;
    QwtSymbol* d_symbol = nullptr;
    radar_plots::MarkerRow d_marker;

    std::mutex d_mutex;
    std::vector<float> d_x;
    std::vector<float> d_y;
    bool d_fresh = false;
};

// gr-radar's "QT GUI Spectrogram Plot": one tagged packet of `vlen`-long float
// vectors drawn as a matrix, which is how a range-Doppler map is displayed.
// Rebuild of gr-radar/lib/spectrogram_plot.cc plus its tagged_stream_block.
class RadarSpectrogramPlotWasm : public gr::tagged_stream_block
{
public:
    using sptr = std::shared_ptr<RadarSpectrogramPlotWasm>;

    static sptr make(int vlen,
                     int interval,
                     const std::string& xlabel,
                     const std::string& ylabel,
                     const std::string& label,
                     const std::vector<float>& axis_x,
                     const std::vector<float>& axis_y,
                     const std::vector<float>& axis_z,
                     bool autoscale_z,
                     const std::string& len_key);

    RadarSpectrogramPlotWasm(int vlen,
                             int interval,
                             const std::string& xlabel,
                             const std::string& ylabel,
                             const std::string& label,
                             const std::vector<float>& axis_x,
                             const std::vector<float>& axis_y,
                             const std::vector<float>& axis_z,
                             bool autoscale_z,
                             const std::string& len_key);

    QWidget* qwidget() const { return d_widget; }

    int calculate_output_stream_length(const gr_vector_int& ninput_items) override;
    int work(int noutput_items,
             gr_vector_int& ninput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    void refresh();

    const int d_vlen;
    const std::vector<float> d_axis_x;
    const std::vector<float> d_axis_y;
    const std::vector<float> d_axis_z;
    const bool d_autoscale_z;

    QWidget* d_widget = nullptr;
    QwtPlot* d_plot = nullptr;
    QwtPlotSpectrogram* d_spectrogram = nullptr;

    std::mutex d_mutex;
    std::vector<float> d_buffer;
    bool d_fresh = false;
};
