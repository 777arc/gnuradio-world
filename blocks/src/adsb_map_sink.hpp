#pragma once

// Message sink for the browser-native ADS-B map. GNU Radio message handlers
// only parse and coalesce decoder PDUs; a QWidget-owned timer transfers compact
// JSON batches to runner/src/adsb_map.js on the browser main thread.

#include <gnuradio/block.h>
#include <pmt/pmt.h>

#include <QTimer>
#include <QPointer>
#include <QWidget>

#include <map>
#include <memory>
#include <mutex>
#include <string>

class AdsbMapSinkWasm : public gr::block
{
public:
    using sptr = std::shared_ptr<AdsbMapSinkWasm>;

    static sptr make(const std::string& instance_name,
                     const std::string& title,
                     const std::string& basemap,
                     const std::string& units,
                     bool show_receiver,
                     double receiver_latitude,
                     double receiver_longitude,
                     bool show_labels,
                     double trail_seconds,
                     double stale_seconds,
                     double expire_seconds,
                     double update_time);

    AdsbMapSinkWasm(const std::string& instance_name,
                    const std::string& title,
                    const std::string& basemap,
                    const std::string& units,
                    bool show_receiver,
                    double receiver_latitude,
                    double receiver_longitude,
                    bool show_labels,
                    double trail_seconds,
                    double stale_seconds,
                    double expire_seconds,
                    double update_time);
    ~AdsbMapSinkWasm() override;

    QWidget* qwidget() const { return d_widget; }

private:
    void handle(const pmt::pmt_t& message);
    void flush();

    QWidget* d_widget = nullptr;
    QPointer<QTimer> d_timer;
    int d_renderer_id = 0;
    std::mutex d_mutex;
    std::map<std::string, std::string> d_pending;
};
