#pragma once

// Browser-safe Qt6/Qwt rebuild of gr-inspector's QT GUI Inspector Sink.
//
// Upstream's block shares std::vectors directly between GNU Radio worker
// threads and a QTimer on the GUI thread.  This rebuild keeps the native GRC
// id, ports, parameters and visual model, but crosses that boundary through a
// locked state snapshot.  The QWidget itself is owned by the runner's GUI
// layout; the block never deletes it.

#include <gnuradio/sync_block.h>
#include <pmt/pmt.h>

#include <memory>

class QWidget;
struct InspectorGuiState;

class InspectorGuiSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<InspectorGuiSinkWasm>;

    static sptr make(double sample_rate,
                     int fft_length,
                     double center_frequency,
                     int rf_unit,
                     int analysis_ports,
                     bool manual);

    InspectorGuiSinkWasm(double sample_rate,
                         int fft_length,
                         double center_frequency,
                         int rf_unit,
                         int analysis_ports,
                         bool manual);
    ~InspectorGuiSinkWasm() override = default;

    QWidget* qwidget() const { return d_widget; }

    void set_sample_rate(double value);
    void set_center_frequency(double value);
    void set_rf_unit(int value);

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override;

private:
    void handle_map(const pmt::pmt_t& message);
    void handle_analysis(const pmt::pmt_t& message);

    const int d_fft_length;
    std::shared_ptr<InspectorGuiState> d_state;
    QWidget* d_widget = nullptr;
};
