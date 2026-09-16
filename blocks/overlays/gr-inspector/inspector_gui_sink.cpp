#include "inspector_gui_sink.hpp"

#include <gnuradio/io_signature.h>

#include <QCheckBox>
#include <QColor>
#include <QEvent>
#include <QHBoxLayout>
#include <QLabel>
#include <QMouseEvent>
#include <QPen>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>

#include <qwt_axis.h>
#include <qwt_interval.h>
#include <qwt_plot.h>
#include <qwt_plot_canvas.h>
#include <qwt_plot_curve.h>
#include <qwt_plot_grid.h>
#include <qwt_plot_marker.h>
#include <qwt_plot_zoomer.h>
#include <qwt_plot_zoneitem.h>
#include <qwt_text.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr int kRefreshMs = 250;
constexpr std::size_t kMarkerCount = 30;

struct Band
{
    double center = 0.0; // relative to the receiver centre frequency, in Hz
    double bandwidth = 0.0;
};

int valid_unit(int unit)
{
    switch (unit) {
    case 1:
    case 1000:
    case 1000000:
    case 1000000000:
        return unit;
    default:
        return 1;
    }
}

QString unit_text(int unit)
{
    switch (unit) {
    case 1000:
        return QStringLiteral("kHz");
    case 1000000:
        return QStringLiteral("MHz");
    case 1000000000:
        return QStringLiteral("GHz");
    default:
        return QStringLiteral("Hz");
    }
}

std::string compact_number(double value)
{
    std::ostringstream stream;
    stream << std::setprecision(6) << value;
    return stream.str();
}

bool unpack_map(const pmt::pmt_t& message, std::vector<Band>& bands)
{
    if (!pmt::is_vector(message))
        return false;

    std::vector<Band> parsed;
    const std::size_t count = pmt::length(message);
    parsed.reserve(std::min(count, kMarkerCount));
    for (std::size_t i = 0; i < count; ++i) {
        const pmt::pmt_t row = pmt::vector_ref(message, i);
        if (!pmt::is_f32vector(row) || pmt::length(row) < 2)
            continue;
        const double center = pmt::f32vector_ref(row, 0);
        const double bandwidth = pmt::f32vector_ref(row, 1);
        if (!std::isfinite(center) || !std::isfinite(bandwidth) || bandwidth < 0.0)
            continue;
        parsed.push_back({ center, bandwidth });
        if (parsed.size() == kMarkerCount)
            break;
    }
    bands = std::move(parsed);
    return true;
}

bool unpack_analysis(const pmt::pmt_t& message, int& signal, std::string& text)
{
    if (!pmt::is_tuple(message) || pmt::length(message) == 0)
        return false;
    const pmt::pmt_t identity = pmt::tuple_ref(message, 0);
    if (!pmt::is_tuple(identity) || pmt::length(identity) < 2)
        return false;

    try {
        signal = static_cast<int>(pmt::to_uint64(pmt::tuple_ref(identity, 1)));
    } catch (...) {
        return false;
    }
    if (signal < 0)
        return false;

    std::ostringstream stream;
    for (std::size_t i = 1; i < pmt::length(message); ++i) {
        const pmt::pmt_t field = pmt::tuple_ref(message, i);
        if (!pmt::is_tuple(field) || pmt::length(field) < 2 ||
            !pmt::is_symbol(pmt::tuple_ref(field, 0)))
            continue;
        const pmt::pmt_t value = pmt::tuple_ref(field, 1);
        double number;
        try {
            number = pmt::to_double(value);
        } catch (...) {
            try {
                number = pmt::to_float(value);
            } catch (...) {
                continue;
            }
        }
        stream << pmt::symbol_to_string(pmt::tuple_ref(field, 0)) << ": "
               << compact_number(number) << '\n';
    }
    text = stream.str();
    return true;
}

pmt::pmt_t make_map_message(const Band& band)
{
    pmt::pmt_t row = pmt::make_f32vector(2, 0.0F);
    pmt::f32vector_set(row, 0, static_cast<float>(band.center));
    pmt::f32vector_set(row, 1, static_cast<float>(band.bandwidth));
    pmt::pmt_t result = pmt::make_vector(1, pmt::PMT_NIL);
    pmt::vector_set(result, 0, row);
    return result;
}

class InspectorZoomer : public QwtPlotZoomer
{
public:
    explicit InspectorZoomer(QWidget* canvas)
        : QwtPlotZoomer(QwtAxis::XBottom, QwtAxis::YLeft, canvas)
    {
        setTrackerMode(QwtPicker::AlwaysOn);
        setRubberBand(QwtPicker::RectRubberBand);
        const QPen pen(QColor(120, 120, 120), 1, Qt::DashLine);
        setTrackerPen(pen);
        setRubberBandPen(pen);
        setMousePattern(
            QwtEventPattern::MouseSelect1, Qt::LeftButton, Qt::ControlModifier);
        setMousePattern(
            QwtEventPattern::MouseSelect2, Qt::RightButton, Qt::ControlModifier);
        setMousePattern(QwtEventPattern::MouseSelect3, Qt::RightButton);
    }
};

struct PlotMarker
{
    std::unique_ptr<QwtPlotMarker> center = std::make_unique<QwtPlotMarker>();
    std::unique_ptr<QwtPlotMarker> label = std::make_unique<QwtPlotMarker>();
    std::unique_ptr<QwtPlotZoneItem> zone = std::make_unique<QwtPlotZoneItem>();

    void detach()
    {
        center->detach();
        label->detach();
        zone->detach();
    }
};

} // namespace

struct InspectorGuiState
{
    std::mutex mutex;
    std::vector<float> spectrum;
    std::vector<Band> bands;
    std::map<int, std::string> analysis;
    std::optional<Band> manual_band;
    std::optional<Band> pending_manual;
    pmt::pmt_t last_automatic = pmt::PMT_NIL;
    double sample_rate = 1.0;
    double center_frequency = 0.0;
    int rf_unit = 1;
    bool manual = false;
    bool has_automatic = false;
    bool resend_automatic = false;
    std::uint64_t spectrum_version = 0;
    std::uint64_t overlay_version = 0;
    std::uint64_t axis_version = 0;
};

namespace {

class InspectorGuiWidget final : public QWidget
{
public:
    InspectorGuiWidget(std::shared_ptr<InspectorGuiState> state, int fft_length)
        : d_state(std::move(state)), d_fft_length(fft_length)
    {
        auto* root = new QVBoxLayout(this);
        root->setContentsMargins(0, 0, 0, 0);
        root->setSpacing(2);

        auto* toolbar = new QHBoxLayout;
        toolbar->setContentsMargins(8, 2, 8, 0);
        d_manual_checkbox = new QCheckBox(QStringLiteral("Manual selection"), this);
        toolbar->addWidget(d_manual_checkbox);
        toolbar->addStretch();
        root->addLayout(toolbar);

        d_plot = new QwtPlot(this);
        d_plot->setAutoDelete(false);
        d_plot->setTitle(QwtText(QStringLiteral("Inspector GUI")));
        d_plot->setAxisTitle(QwtAxis::YLeft, QwtText(QStringLiteral("dB")));
        d_plot->setAxisScale(QwtAxis::YLeft, -120.0, 30.0);
        d_plot->setCanvasBackground(QColor(30, 30, 30));
        if (auto* canvas = dynamic_cast<QwtPlotCanvas*>(d_plot->canvas()))
            canvas->setPaintAttribute(QwtPlotCanvas::ImmediatePaint, true);

        // Keep the native sink's three zoom bindings discoverable without
        // taking plot space or stealing pointer events from Qwt/manual mode.
        auto* controls = new QLabel(
            QStringLiteral("Ctrl + left-drag: zoom in\n"
                           "Right-click: zoom out\n"
                           "Ctrl + right-click: reset"),
            d_plot->canvas());
        controls->setObjectName(QStringLiteral("inspectorControlsLegend"));
        controls->setAttribute(Qt::WA_TransparentForMouseEvents);
        controls->setStyleSheet(QStringLiteral(
            "QLabel { color: #e5e7eb; background: rgba(15, 18, 25, 190); "
            "border: 1px solid rgba(229, 231, 235, 80); border-radius: 3px; "
            "padding: 4px 6px; font-size: 11px; }"));
        controls->adjustSize();
        controls->move(8, 8);
        controls->raise();
        root->addWidget(d_plot, 1);

        d_grid = std::make_unique<QwtPlotGrid>();
        d_grid->setPen(QPen(QColor(60, 60, 60), 0.5, Qt::DashLine));
        d_grid->attach(d_plot);

        d_curve = std::make_unique<QwtPlotCurve>();
        d_curve->setPen(QPen(Qt::cyan, 1));
        d_curve->attach(d_plot);

        d_markers.reserve(kMarkerCount);
        for (std::size_t i = 0; i < kMarkerCount; ++i)
            d_markers.push_back(std::make_unique<PlotMarker>());

        d_zoomer = new InspectorZoomer(d_plot->canvas());
        d_plot->canvas()->installEventFilter(this);

        bool manual;
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            manual = d_state->manual;
        }
        d_manual_checkbox->setChecked(manual);
        QObject::connect(d_manual_checkbox,
                         &QCheckBox::toggled,
                         this,
                         [this](bool checked) { set_manual(checked); });

        refresh();
        if (manual)
            create_manual_band();

        auto* timer = new QTimer(this);
        QObject::connect(timer, &QTimer::timeout, this, [this] { refresh(); });
        timer->start(kRefreshMs);
        setMinimumSize(280, 200);
    }

    ~InspectorGuiWidget() override
    {
        for (auto& marker : d_markers)
            marker->detach();
        d_curve->detach();
        d_grid->detach();
    }

protected:
    bool eventFilter(QObject* watched, QEvent* event) override
    {
        if (watched != d_plot->canvas())
            return QWidget::eventFilter(watched, event);

        bool manual;
        std::optional<Band> band;
        double center_frequency;
        int unit;
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            manual = d_state->manual;
            band = d_state->manual_band;
            center_frequency = d_state->center_frequency;
            unit = d_state->rf_unit;
        }
        if (!manual || !band)
            return QWidget::eventFilter(watched, event);

        auto* mouse = dynamic_cast<QMouseEvent*>(event);
        if (!mouse)
            return QWidget::eventFilter(watched, event);
        const double display_frequency =
            d_plot->invTransform(QwtAxis::XBottom, mouse->position().x());
        const double absolute_hz = display_frequency * unit;
        const double center_hz = center_frequency + band->center;
        const double left_hz = center_hz - band->bandwidth / 2.0;
        const double right_hz = center_hz + band->bandwidth / 2.0;

        if (event->type() == QEvent::MouseButtonPress &&
            mouse->button() == Qt::LeftButton &&
            !(mouse->modifiers() & Qt::ControlModifier)) {
            const double left_px = d_plot->transform(QwtAxis::XBottom, left_hz / unit);
            const double right_px = d_plot->transform(QwtAxis::XBottom, right_hz / unit);
            if (std::abs(left_px - mouse->position().x()) <= 5.0)
                d_drag = Drag::Left;
            else if (std::abs(right_px - mouse->position().x()) <= 5.0)
                d_drag = Drag::Right;
            else if (absolute_hz >= left_hz && absolute_hz <= right_hz) {
                d_drag = Drag::Center;
                d_drag_offset_hz = absolute_hz - center_hz;
            } else {
                d_drag = Drag::None;
            }
            if (d_drag != Drag::None) {
                d_zoomer->setEnabled(false);
                return true;
            }
        }

        if (event->type() == QEvent::MouseMove) {
            d_plot->canvas()->setCursor(absolute_hz >= left_hz && absolute_hz <= right_hz
                                            ? Qt::SizeHorCursor
                                            : Qt::CrossCursor);
            if (d_drag != Drag::None && (mouse->buttons() & Qt::LeftButton)) {
                update_manual_band(absolute_hz, false);
                return true;
            }
        }

        if (event->type() == QEvent::MouseButtonRelease &&
            mouse->button() == Qt::LeftButton && d_drag != Drag::None) {
            update_manual_band(absolute_hz, true);
            d_drag = Drag::None;
            d_drag_offset_hz = 0.0;
            d_zoomer->setEnabled(true);
            return true;
        }
        return QWidget::eventFilter(watched, event);
    }

private:
    enum class Drag { None, Left, Center, Right };

    void set_manual(bool manual)
    {
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            if (d_state->manual == manual)
                return;
            d_state->manual = manual;
            d_state->resend_automatic = !manual && d_state->has_automatic;
            ++d_state->overlay_version;
        }
        if (manual)
            create_manual_band();
        else
            refresh();
    }

    void create_manual_band()
    {
        const QRectF visible = d_zoomer->zoomRect();
        double sample_rate;
        double center_frequency;
        int unit;
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            sample_rate = d_state->sample_rate;
            center_frequency = d_state->center_frequency;
            unit = d_state->rf_unit;
        }
        Band band;
        band.center = (visible.center().x() * unit) - center_frequency;
        band.bandwidth = std::min(sample_rate, std::abs(visible.width() * unit) / 2.0);
        band.bandwidth = std::max(band.bandwidth, sample_rate / d_fft_length);
        clamp_band(band, sample_rate);
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            d_state->manual_band = band;
            d_state->pending_manual = band;
            ++d_state->overlay_version;
        }
        refresh();
    }

    static void clamp_band(Band& band, double sample_rate)
    {
        band.bandwidth = std::clamp(band.bandwidth, 0.0, sample_rate);
        const double half = band.bandwidth / 2.0;
        band.center = std::clamp(band.center, -sample_rate / 2.0 + half,
                                 sample_rate / 2.0 - half);
    }

    void update_manual_band(double absolute_hz, bool publish)
    {
        Band band;
        double sample_rate;
        double center_frequency;
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            if (!d_state->manual_band)
                return;
            band = *d_state->manual_band;
            sample_rate = d_state->sample_rate;
            center_frequency = d_state->center_frequency;
        }
        if (d_drag == Drag::Center)
            band.center = absolute_hz - d_drag_offset_hz - center_frequency;
        else {
            const double center_hz = center_frequency + band.center;
            band.bandwidth = 2.0 * std::abs(absolute_hz - center_hz);
            band.bandwidth = std::max(band.bandwidth, sample_rate / d_fft_length);
        }
        clamp_band(band, sample_rate);
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            d_state->manual_band = band;
            if (publish)
                d_state->pending_manual = band;
            ++d_state->overlay_version;
        }
        refresh();
    }

    void set_axis(double sample_rate, double center_frequency, int unit)
    {
        const double start = (center_frequency - sample_rate / 2.0) / unit;
        const double stop =
            (center_frequency + sample_rate / 2.0 - sample_rate / d_fft_length) / unit;
        d_plot->setAxisScale(QwtAxis::XBottom, start, stop);
        d_plot->setAxisTitle(QwtAxis::XBottom,
                             QwtText(QStringLiteral("Frequency [%1]").arg(unit_text(unit))));
        d_frequencies.resize(d_fft_length);
        const double step = sample_rate / d_fft_length / unit;
        for (int i = 0; i < d_fft_length; ++i)
            d_frequencies[i] = start + i * step;
        d_zoomer->setZoomBase(true);
        d_zoomer->zoom(0);
    }

    void draw_marker(PlotMarker& marker,
                     std::size_t number,
                     const Band& band,
                     const std::string& analysis,
                     double center_frequency,
                     int unit,
                     double label_y)
    {
        const double absolute_center = center_frequency + band.center;
        const double display_center = absolute_center / unit;
        const double display_bandwidth = band.bandwidth / unit;

        QColor line_color = Qt::white;
        line_color.setAlpha(70);
        marker.center->setLineStyle(QwtPlotMarker::VLine);
        marker.center->setLinePen(QPen(line_color));
        marker.center->setXValue(display_center);

        QColor zone_color = Qt::red;
        zone_color.setAlpha(100);
        marker.zone->setOrientation(Qt::Vertical);
        marker.zone->setPen(QPen(zone_color));
        zone_color.setAlpha(20);
        marker.zone->setBrush(QBrush(zone_color));
        marker.zone->setInterval(display_center - display_bandwidth / 2.0,
                                 display_center + display_bandwidth / 2.0);
        marker.zone->setXAxis(QwtAxis::XBottom);

        QString label = QStringLiteral("Signal %1\nf = %2 %3\nB = %4 %3")
                            .arg(number + 1)
                            .arg(display_center, 0, 'g', 6)
                            .arg(unit_text(unit))
                            .arg(display_bandwidth, 0, 'g', 6);
        if (!analysis.empty())
            label += QStringLiteral("\n") + QString::fromStdString(analysis).trimmed();
        QwtText text(label);
        text.setColor(Qt::red);
        marker.label->setLabelAlignment(Qt::AlignLeft);
        marker.label->setLabel(text);
        marker.label->setValue(display_center - display_bandwidth / 2.0, label_y);

        marker.label->attach(d_plot);
        marker.zone->attach(d_plot);
        marker.center->attach(d_plot);
    }

    void refresh()
    {
        std::vector<float> spectrum;
        std::vector<Band> bands;
        std::map<int, std::string> analysis;
        std::optional<Band> manual_band;
        double sample_rate;
        double center_frequency;
        int unit;
        bool manual;
        std::uint64_t spectrum_version;
        std::uint64_t overlay_version;
        std::uint64_t axis_version;
        {
            std::lock_guard<std::mutex> lock(d_state->mutex);
            spectrum_version = d_state->spectrum_version;
            overlay_version = d_state->overlay_version;
            axis_version = d_state->axis_version;
            sample_rate = d_state->sample_rate;
            center_frequency = d_state->center_frequency;
            unit = d_state->rf_unit;
            manual = d_state->manual;
            manual_band = d_state->manual_band;
            if (spectrum_version != d_spectrum_version)
                spectrum = d_state->spectrum;
            if (overlay_version != d_overlay_version) {
                bands = d_state->bands;
                analysis = d_state->analysis;
            }
        }

        bool changed = false;
        if (axis_version != d_axis_version) {
            set_axis(sample_rate, center_frequency, unit);
            d_axis_version = axis_version;
            changed = true;
        }
        if (spectrum_version != d_spectrum_version &&
            spectrum.size() == static_cast<std::size_t>(d_fft_length)) {
            d_spectrum.assign(spectrum.begin(), spectrum.end());
            d_curve->setRawSamples(d_frequencies.data(), d_spectrum.data(), d_fft_length);
            d_spectrum_version = spectrum_version;
            changed = true;
        }
        if (overlay_version != d_overlay_version) {
            for (auto& marker : d_markers)
                marker->detach();
            const QRectF visible = d_zoomer->zoomRect();
            const double label_y = visible.y() + visible.height() * 0.85;
            if (manual && manual_band) {
                draw_marker(*d_markers[0],
                            0,
                            *manual_band,
                            std::string(),
                            center_frequency,
                            unit,
                            label_y);
            } else {
                const std::size_t count = std::min(bands.size(), kMarkerCount);
                for (std::size_t i = 0; i < count; ++i) {
                    const auto found = analysis.find(static_cast<int>(i));
                    draw_marker(*d_markers[i],
                                i,
                                bands[i],
                                found == analysis.end() ? std::string() : found->second,
                                center_frequency,
                                unit,
                                label_y);
                }
            }
            d_overlay_version = overlay_version;
            changed = true;
        }
        if (changed)
            d_plot->replot();
    }

    std::shared_ptr<InspectorGuiState> d_state;
    const int d_fft_length;
    QCheckBox* d_manual_checkbox = nullptr;
    QwtPlot* d_plot = nullptr;
    InspectorZoomer* d_zoomer = nullptr;
    std::unique_ptr<QwtPlotGrid> d_grid;
    std::unique_ptr<QwtPlotCurve> d_curve;
    std::vector<std::unique_ptr<PlotMarker>> d_markers;
    std::vector<double> d_frequencies;
    std::vector<double> d_spectrum;
    std::uint64_t d_spectrum_version = UINT64_MAX;
    std::uint64_t d_overlay_version = UINT64_MAX;
    std::uint64_t d_axis_version = UINT64_MAX;
    Drag d_drag = Drag::None;
    double d_drag_offset_hz = 0.0;
};

} // namespace

InspectorGuiSinkWasm::sptr InspectorGuiSinkWasm::make(double sample_rate,
                                                       int fft_length,
                                                       double center_frequency,
                                                       int rf_unit,
                                                       int analysis_ports,
                                                       bool manual)
{
    return gnuradio::make_block_sptr<InspectorGuiSinkWasm>(sample_rate,
                                                           fft_length,
                                                           center_frequency,
                                                           rf_unit,
                                                           analysis_ports,
                                                           manual);
}

InspectorGuiSinkWasm::InspectorGuiSinkWasm(double sample_rate,
                                           int fft_length,
                                           double center_frequency,
                                           int rf_unit,
                                           int analysis_ports,
                                           bool manual)
    : gr::sync_block("qtgui_inspector_sink_vf",
                     gr::io_signature::make(
                         1, 1, sizeof(float) * std::max(1, fft_length)),
                     gr::io_signature::make(0, 0, 0)),
      d_fft_length(std::max(1, fft_length)),
      d_state(std::make_shared<InspectorGuiState>())
{
    d_state->sample_rate = sample_rate > 0.0 ? sample_rate : 1.0;
    d_state->center_frequency = center_frequency;
    d_state->rf_unit = valid_unit(rf_unit);
    d_state->manual = manual;

    message_port_register_out(pmt::mp("map_out"));
    message_port_register_in(pmt::mp("map_in"));
    set_msg_handler(pmt::mp("map_in"),
                    [this](const pmt::pmt_t& message) { handle_map(message); });

    analysis_ports = std::max(0, analysis_ports);
    if (analysis_ports == 1) {
        message_port_register_in(pmt::mp("analysis_in"));
        set_msg_handler(pmt::mp("analysis_in"),
                        [this](const pmt::pmt_t& message) { handle_analysis(message); });
    } else {
        for (int i = 0; i < analysis_ports; ++i) {
            const pmt::pmt_t port = pmt::mp("analysis_in" + std::to_string(i));
            message_port_register_in(port);
            set_msg_handler(port,
                            [this](const pmt::pmt_t& message) { handle_analysis(message); });
        }
    }

    d_widget = new InspectorGuiWidget(d_state, d_fft_length);
}

void InspectorGuiSinkWasm::set_sample_rate(double value)
{
    if (!(value > 0.0) || !std::isfinite(value))
        return;
    std::lock_guard<std::mutex> lock(d_state->mutex);
    d_state->sample_rate = value;
    ++d_state->axis_version;
    ++d_state->overlay_version;
}

void InspectorGuiSinkWasm::set_center_frequency(double value)
{
    if (!std::isfinite(value))
        return;
    std::lock_guard<std::mutex> lock(d_state->mutex);
    d_state->center_frequency = value;
    ++d_state->axis_version;
    ++d_state->overlay_version;
}

void InspectorGuiSinkWasm::set_rf_unit(int value)
{
    std::lock_guard<std::mutex> lock(d_state->mutex);
    d_state->rf_unit = valid_unit(value);
    ++d_state->axis_version;
    ++d_state->overlay_version;
}

void InspectorGuiSinkWasm::handle_map(const pmt::pmt_t& message)
{
    std::vector<Band> bands;
    if (!unpack_map(message, bands))
        return;

    bool forward;
    {
        std::lock_guard<std::mutex> lock(d_state->mutex);
        d_state->bands = std::move(bands);
        d_state->last_automatic = message;
        d_state->has_automatic = true;
        forward = !d_state->manual;
        ++d_state->overlay_version;
    }
    if (forward)
        message_port_pub(pmt::mp("map_out"), message);
}

void InspectorGuiSinkWasm::handle_analysis(const pmt::pmt_t& message)
{
    int signal;
    std::string text;
    if (!unpack_analysis(message, signal, text))
        return;
    std::lock_guard<std::mutex> lock(d_state->mutex);
    d_state->analysis[signal] = std::move(text);
    ++d_state->overlay_version;
}

int InspectorGuiSinkWasm::work(int noutput_items,
                               gr_vector_const_void_star& input_items,
                               gr_vector_void_star&)
{
    const float* input = static_cast<const float*>(input_items[0]);
    const float* latest = input + (noutput_items - 1) * d_fft_length;
    std::optional<Band> manual;
    pmt::pmt_t automatic = pmt::PMT_NIL;
    {
        std::lock_guard<std::mutex> lock(d_state->mutex);
        d_state->spectrum.assign(latest, latest + d_fft_length);
        ++d_state->spectrum_version;
        manual = d_state->pending_manual;
        d_state->pending_manual.reset();
        if (d_state->resend_automatic && d_state->has_automatic) {
            automatic = d_state->last_automatic;
            d_state->resend_automatic = false;
        }
    }
    if (manual)
        message_port_pub(pmt::mp("map_out"), make_map_message(*manual));
    if (!pmt::is_null(automatic))
        message_port_pub(pmt::mp("map_out"), automatic);
    return noutput_items;
}
