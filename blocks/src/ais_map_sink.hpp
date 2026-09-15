#pragma once

// Message sink for the browser-native AIS vessel map. The GNU Radio message
// handler only queues each packet's bytes -- a deframed AIS payload from HDLC
// Deframer, or an !AIVDM sentence from AIS PDU to NMEA -- and a QWidget-owned
// timer transfers compact JSON batches to runner/src/ais_map.js on the browser
// main thread, where the AIS message decoding lives so it can be tested on
// plain Node beside the renderer.

#include <gnuradio/block.h>
#include <pmt/pmt.h>

#include <QTimer>
#include <QPointer>
#include <QWidget>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

class AisMapSinkWasm : public gr::block
{
public:
    using sptr = std::shared_ptr<AisMapSinkWasm>;

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

    AisMapSinkWasm(const std::string& instance_name,
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
    ~AisMapSinkWasm() override;

    QWidget* qwidget() const { return d_widget; }

private:
    void handle(const pmt::pmt_t& message);
    void flush();

    QWidget* d_widget = nullptr;
    QPointer<QTimer> d_timer;
    int d_renderer_id = 0;
    std::mutex d_mutex;
    // Each entry is one packet, already JSON-encoded: {"payload": "<hex>"} for
    // deframed bytes, {"nmea": "..."} for a sentence.
    std::vector<std::string> d_pending;
    std::size_t d_dropped = 0;
};
