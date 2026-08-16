#pragma once

#include <cstddef>
#include <cstdint>

namespace plutosdr {

enum State : std::int32_t {
    INITIAL = 0,
    RUNNING = 1,
    ERROR = 2,
    CANCELLED = 3,
};

enum GainMode : std::int32_t {
    SLOW_ATTACK = 0,
    FAST_ATTACK = 1,
    HYBRID = 2,
    MANUAL = 3,
};

constexpr std::int32_t FLAG_QUADRATURE = 1 << 0;
constexpr std::int32_t FLAG_RF_DC = 1 << 1;
constexpr std::int32_t FLAG_BB_DC = 1 << 2;

// Shared-memory ABI mirrored by CTRL in runner/src/plutosdr_worker.js. Source
// and Sink use the same layout: read_pos belongs to the consumer, write_pos to
// the producer, and the command mailbox is written only by C++ and read only by
// the worker. value*_milli is RX gain or TX attenuation, depending on direction.
struct alignas(4) Control {
    std::int32_t read_pos = 0;
    std::int32_t write_pos = 0;
    std::int32_t state = INITIAL;
    std::int32_t error_length = 0;
    std::int32_t events = 0;          // RX overruns or TX underflows
    std::int32_t lost_samples = 0;    // RX samples dropped; TX never drops
    std::int32_t actual_rate = 0;
    std::int32_t cmd_seq = 0;
    std::int32_t cmd_ack = 0;
    std::int32_t freq_hi = 0;
    std::int32_t freq_lo = 0;
    std::int32_t bandwidth = 0;
    std::int32_t value1_milli = 0;
    std::int32_t value2_milli = 0;
    std::int32_t mode1 = SLOW_ATTACK;
    std::int32_t mode2 = SLOW_ATTACK;
    std::int32_t flags = 0;
};

constexpr double RING_SECONDS = 0.25;
constexpr std::size_t MIN_RING_FRAMES = 32 * 1024;
constexpr std::size_t MAX_RING_FRAMES = 1024 * 1024;
constexpr std::size_t ERROR_BYTES = 512;

} // namespace plutosdr
