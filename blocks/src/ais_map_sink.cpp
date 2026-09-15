#include "ais_map_sink.hpp"

#include <gnuradio/io_signature.h>

#include <emscripten.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <utility>

using nlohmann::json;

namespace {

// AIS is 9600 bit/s per channel, so even two saturated channels are under a
// hundred packets a second; this only bounds a renderer that stopped draining.
constexpr std::size_t kMaximumPendingPackets = 2048;

std::string hex(const std::uint8_t* bytes, std::size_t length)
{
    static const char digits[] = "0123456789abcdef";
    std::string out;
    out.reserve(length * 2);
    for (std::size_t i = 0; i < length; ++i) {
        out.push_back(digits[bytes[i] >> 4]);
        out.push_back(digits[bytes[i] & 0x0f]);
    }
    return out;
}

} // namespace

AisMapSinkWasm::sptr AisMapSinkWasm::make(
    const std::string& instance_name,
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
    double update_time)
{
    return gnuradio::make_block_sptr<AisMapSinkWasm>(instance_name,
                                                      title,
                                                      basemap,
                                                      units,
                                                      show_receiver,
                                                      receiver_latitude,
                                                      receiver_longitude,
                                                      show_labels,
                                                      trail_seconds,
                                                      stale_seconds,
                                                      expire_seconds,
                                                      update_time);
}

AisMapSinkWasm::AisMapSinkWasm(
    const std::string& instance_name,
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
    double update_time)
    : gr::block(instance_name,
                gr::io_signature::make(0, 0, 0),
                gr::io_signature::make(0, 0, 0)),
      d_widget(new QWidget)
{
    if (basemap != "light" && basemap != "dark" && basemap != "none")
        throw std::runtime_error("AIS Map basemap must be light, dark, or none");
    if (units != "nautical" && units != "metric")
        throw std::runtime_error("AIS Map units must be nautical or metric");
    if (receiver_latitude < -90.0 || receiver_latitude > 90.0 ||
        receiver_longitude < -180.0 || receiver_longitude > 180.0)
        throw std::runtime_error("AIS Map receiver coordinates are out of range");
    if (trail_seconds < 0.0 || stale_seconds <= 0.0 ||
        expire_seconds <= stale_seconds || update_time < 0.05)
        throw std::runtime_error("AIS Map timing parameters are invalid");

    d_widget->setMinimumSize(560, 360);
    d_widget->setStyleSheet(QStringLiteral("background:#07121f;"));

    const json configuration = {
        { "blockName", instance_name },
        { "title", title },
        { "basemap", basemap },
        { "units", units },
        { "showReceiver", show_receiver },
        { "receiverLatitude", receiver_latitude },
        { "receiverLongitude", receiver_longitude },
        { "showLabels", show_labels },
        { "trailSeconds", trail_seconds },
        { "staleSeconds", stale_seconds },
        { "expireSeconds", expire_seconds },
    };
    const std::string configuration_text = configuration.dump();
    d_renderer_id = MAIN_THREAD_EM_ASM_INT(
        {
            const manager = globalThis.__grAisMap;
            if (!manager) return 0;
            return manager.create(UTF8ToString($0));
        },
        configuration_text.c_str());
    if (!d_renderer_id)
        throw std::runtime_error("AIS Map browser renderer initialization failed");

    d_timer = new QTimer(d_widget);
    QObject::connect(d_timer, &QTimer::timeout, d_widget, [this] { flush(); });
    d_timer->start(static_cast<int>(std::clamp(update_time, 0.05, 10.0) * 1000.0));

    const pmt::pmt_t input = pmt::intern("in");
    message_port_register_in(input);
    set_msg_handler(input, [this](const pmt::pmt_t& message) { handle(message); });
}

AisMapSinkWasm::~AisMapSinkWasm()
{
    if (d_timer)
        d_timer->stop();
    if (!d_renderer_id)
        return;
    MAIN_THREAD_EM_ASM(
        {
            globalThis.__grAisMap?.destroy($0);
        },
        d_renderer_id);
}

void AisMapSinkWasm::handle(const pmt::pmt_t& message)
{
    // A PDU (metadata . u8vector) from HDLC Deframer or AIS PDU to NMEA, or a
    // bare u8vector or string carrying either form.
    pmt::pmt_t data = pmt::is_pair(message) ? pmt::cdr(message) : message;
    json packet;
    if (pmt::is_u8vector(data)) {
        std::size_t length = 0;
        const std::uint8_t* bytes = pmt::u8vector_elements(data, length);
        if (length == 0)
            return;
        if (bytes[0] == '!' || bytes[0] == '$')
            packet["nmea"] = std::string(reinterpret_cast<const char*>(bytes), length);
        else
            packet["payload"] = hex(bytes, length);
    } else if (pmt::is_symbol(data)) {
        packet["nmea"] = pmt::symbol_to_string(data);
    } else {
        return;
    }

    std::lock_guard<std::mutex> lock(d_mutex);
    if (d_pending.size() >= kMaximumPendingPackets) {
        ++d_dropped;
        return;
    }
    d_pending.push_back(packet.dump());
}

void AisMapSinkWasm::flush()
{
    std::vector<std::string> pending;
    std::size_t dropped = 0;
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        if (d_pending.empty() && d_dropped == 0)
            return;
        pending.swap(d_pending);
        dropped = std::exchange(d_dropped, 0);
    }

    json batch = json::array();
    for (const auto& encoded : pending)
        batch.push_back(json::parse(encoded));
    if (dropped)
        batch.push_back({ { "dropped", dropped } });
    const std::string encoded = batch.dump();
    MAIN_THREAD_EM_ASM(
        {
            globalThis.__grAisMap?.update($0, UTF8ToString($1));
        },
        d_renderer_id,
        encoded.c_str());
}
