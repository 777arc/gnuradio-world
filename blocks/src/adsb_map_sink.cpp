#include "adsb_map_sink.hpp"

#include <gnuradio/io_signature.h>

#include <emscripten.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

using nlohmann::json;

namespace {

constexpr std::size_t kMaximumPendingAircraft = 1024;

pmt::pmt_t field(const pmt::pmt_t& dictionary, const char* name)
{
    return pmt::dict_ref(dictionary, pmt::intern(name), pmt::PMT_NIL);
}

bool number(const pmt::pmt_t& value, double& result)
{
    if (pmt::is_integer(value)) {
        result = static_cast<double>(pmt::to_long(value));
        return true;
    }
    if (pmt::is_real(value)) {
        result = pmt::to_double(value);
        return true;
    }
    return false;
}

void add_number(json& object, const pmt::pmt_t& dictionary, const char* name)
{
    double value = 0.0;
    if (number(field(dictionary, name), value) && std::isfinite(value))
        object[name] = value;
}

std::string symbol(const pmt::pmt_t& value)
{
    return pmt::is_symbol(value) ? pmt::symbol_to_string(value) : std::string();
}

} // namespace

AdsbMapSinkWasm::sptr AdsbMapSinkWasm::make(
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
    return gnuradio::make_block_sptr<AdsbMapSinkWasm>(instance_name,
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

AdsbMapSinkWasm::AdsbMapSinkWasm(
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
        throw std::runtime_error("ADS-B Map basemap must be light, dark, or none");
    if (units != "aviation" && units != "metric")
        throw std::runtime_error("ADS-B Map units must be aviation or metric");
    if (receiver_latitude < -90.0 || receiver_latitude > 90.0 ||
        receiver_longitude < -180.0 || receiver_longitude > 180.0)
        throw std::runtime_error("ADS-B Map receiver coordinates are out of range");
    if (trail_seconds < 0.0 || stale_seconds <= 0.0 ||
        expire_seconds <= stale_seconds || update_time < 0.05)
        throw std::runtime_error("ADS-B Map timing parameters are invalid");

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
            const manager = globalThis.__grAdsbMap;
            if (!manager) return 0;
            return manager.create(UTF8ToString($0));
        },
        configuration_text.c_str());
    if (!d_renderer_id)
        throw std::runtime_error("ADS-B Map browser renderer initialization failed");

    d_timer = new QTimer(d_widget);
    QObject::connect(d_timer, &QTimer::timeout, d_widget, [this] { flush(); });
    d_timer->start(static_cast<int>(std::clamp(update_time, 0.05, 10.0) * 1000.0));

    const pmt::pmt_t input = pmt::intern("decoded");
    message_port_register_in(input);
    set_msg_handler(input, [this](const pmt::pmt_t& message) { handle(message); });
}

AdsbMapSinkWasm::~AdsbMapSinkWasm()
{
    if (d_timer)
        d_timer->stop();
    if (!d_renderer_id)
        return;
    MAIN_THREAD_EM_ASM(
        {
            globalThis.__grAdsbMap?.destroy($0);
        },
        d_renderer_id);
}

void AdsbMapSinkWasm::handle(const pmt::pmt_t& message)
{
    if (!pmt::is_pair(message))
        return;
    const pmt::pmt_t metadata = pmt::car(message);
    if (!pmt::is_dict(metadata))
        return;

    const std::string icao = symbol(field(metadata, "icao"));
    if (icao.empty() || icao.size() > 16)
        return;

    json update = { { "icao", icao } };
    const std::string callsign = symbol(field(metadata, "callsign"));
    if (!callsign.empty())
        update["callsign"] = callsign;
    const std::string datetime = symbol(field(metadata, "datetime"));
    if (!datetime.empty())
        update["datetime"] = datetime;
    for (const char* name : { "altitude", "speed", "heading", "vertical_rate",
                              "latitude", "longitude", "num_msgs", "timestamp",
                              "df", "snr" })
        add_number(update, metadata, name);

    std::lock_guard<std::mutex> lock(d_mutex);
    if (d_pending.size() >= kMaximumPendingAircraft && !d_pending.count(icao))
        d_pending.erase(d_pending.begin());
    d_pending[icao] = update.dump();
}

void AdsbMapSinkWasm::flush()
{
    std::map<std::string, std::string> pending;
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        if (d_pending.empty())
            return;
        pending.swap(d_pending);
    }

    json batch = json::array();
    for (const auto& [unused, encoded] : pending) {
        (void)unused;
        batch.push_back(json::parse(encoded));
    }
    const std::string encoded = batch.dump();
    MAIN_THREAD_EM_ASM(
        {
            globalThis.__grAdsbMap?.update($0, UTF8ToString($1));
        },
        d_renderer_id,
        encoded.c_str());
}
