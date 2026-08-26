#pragma once

#include "musical_keyboard_synth.hpp"

#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>
#include <gnuradio/sync_block.h>

#include <QComboBox>
#include <QEvent>
#include <QEventPoint>
#include <QFocusEvent>
#include <QHBoxLayout>
#include <QKeyEvent>
#include <QLabel>
#include <QMouseEvent>
#include <QPainter>
#include <QTouchEvent>
#include <QVBoxLayout>
#include <QWidget>

#include <algorithm>
#include <array>
#include <map>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace grworld {

class PianoKeysWidget : public QWidget
{
public:
    PianoKeysWidget(std::shared_ptr<KeyboardNoteState> state,
                    int first_note,
                    int octaves,
                    QWidget* parent = nullptr)
        : QWidget(parent),
          d_state(std::move(state)),
          d_first_note(std::clamp(first_note, 0, 120)),
          d_last_note(std::min(127, d_first_note + std::clamp(octaves, 1, 5) * 12))
    {
        setMinimumSize(520, 145);
        setFocusPolicy(Qt::StrongFocus);
        setAttribute(Qt::WA_AcceptTouchEvents);
        setToolTip(QStringLiteral(
            "Play with the pointer, touch, or A W S E D F T G Y H U J K"));
    }

    ~PianoKeysWidget() override { d_state->release_all(); }

protected:
    void paintEvent(QPaintEvent*) override
    {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        painter.fillRect(rect(), QColor(QStringLiteral("#151823")));

        const auto state = d_state->snapshot();
        const auto keys = key_rects();
        for (const KeyRect& key : keys) {
            if (key.black)
                continue;
            const bool sounding = state.notes[static_cast<std::size_t>(key.note)];
            const bool root = state.roots[static_cast<std::size_t>(key.note)];
            painter.setPen(QPen(QColor(QStringLiteral("#252836")), 1.0));
            painter.setBrush(sounding ? QColor(QStringLiteral("#69d5ff"))
                                      : QColor(QStringLiteral("#f5f6fa")));
            painter.drawRoundedRect(key.rect.adjusted(0.5, 0.5, -0.5, -0.5), 2, 2);
            if (root) {
                painter.setPen(QPen(QColor(QStringLiteral("#ff4fa3")), 3.0));
                painter.setBrush(Qt::NoBrush);
                painter.drawRoundedRect(key.rect.adjusted(2, 2, -2, -2), 2, 2);
            }
            if (key.note % 12 == 0) {
                painter.setPen(QColor(QStringLiteral("#555a68")));
                painter.drawText(key.rect.adjusted(0, 0, 0, -5),
                                 Qt::AlignHCenter | Qt::AlignBottom,
                                 QStringLiteral("C%1").arg(key.note / 12 - 1));
            }
        }

        for (const KeyRect& key : keys) {
            if (!key.black)
                continue;
            const bool sounding = state.notes[static_cast<std::size_t>(key.note)];
            const bool root = state.roots[static_cast<std::size_t>(key.note)];
            painter.setPen(QPen(root ? QColor(QStringLiteral("#ff4fa3"))
                                     : QColor(QStringLiteral("#090a0f")),
                                root ? 3.0 : 1.0));
            painter.setBrush(sounding ? QColor(QStringLiteral("#168fca"))
                                      : QColor(QStringLiteral("#171923")));
            painter.drawRoundedRect(key.rect, 2, 2);
        }
    }

    void mousePressEvent(QMouseEvent* event) override
    {
        if (event->button() != Qt::LeftButton)
            return;
        setFocus(Qt::MouseFocusReason);
        set_mouse_note(note_at(event->position()));
        event->accept();
    }

    void mouseMoveEvent(QMouseEvent* event) override
    {
        if (!(event->buttons() & Qt::LeftButton))
            return;
        set_mouse_note(note_at(event->position()));
        event->accept();
    }

    void mouseReleaseEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton) {
            set_mouse_note(std::nullopt);
            event->accept();
        }
    }

    void leaveEvent(QEvent* event) override
    {
        set_mouse_note(std::nullopt);
        QWidget::leaveEvent(event);
    }

    void keyPressEvent(QKeyEvent* event) override
    {
        if (event->isAutoRepeat()) {
            event->accept();
            return;
        }
        const auto note = note_for_key(event->key());
        if (!note) {
            QWidget::keyPressEvent(event);
            return;
        }
        if (d_keyboard_notes.emplace(event->key(), *note).second)
            d_state->press_root(*note);
        update();
        event->accept();
    }

    void keyReleaseEvent(QKeyEvent* event) override
    {
        if (event->isAutoRepeat()) {
            event->accept();
            return;
        }
        auto found = d_keyboard_notes.find(event->key());
        if (found == d_keyboard_notes.end()) {
            QWidget::keyReleaseEvent(event);
            return;
        }
        d_state->release_root(found->second);
        d_keyboard_notes.erase(found);
        update();
        event->accept();
    }

    void focusOutEvent(QFocusEvent* event) override
    {
        for (const auto& [key, note] : d_keyboard_notes) {
            (void)key;
            d_state->release_root(note);
        }
        d_keyboard_notes.clear();
        update();
        QWidget::focusOutEvent(event);
    }

    bool event(QEvent* event) override
    {
        if (event->type() != QEvent::TouchBegin &&
            event->type() != QEvent::TouchUpdate &&
            event->type() != QEvent::TouchEnd &&
            event->type() != QEvent::TouchCancel)
            return QWidget::event(event);

        std::map<int, int> next;
        if (event->type() != QEvent::TouchCancel) {
            const auto* touch = static_cast<QTouchEvent*>(event);
            for (const QEventPoint& point : touch->points()) {
                if (point.state() == QEventPoint::State::Released)
                    continue;
                if (const auto note = note_at(point.position()))
                    next[point.id()] = *note;
            }
        }
        for (const auto& [id, note] : d_touch_notes) {
            auto found = next.find(id);
            if (found == next.end() || found->second != note)
                d_state->release_root(note);
        }
        for (const auto& [id, note] : next) {
            auto found = d_touch_notes.find(id);
            if (found == d_touch_notes.end() || found->second != note)
                d_state->press_root(note);
        }
        d_touch_notes = std::move(next);
        update();
        event->accept();
        return true;
    }

private:
    struct KeyRect {
        int note;
        QRectF rect;
        bool black;
    };

    static bool is_black(int note)
    {
        const int pitch = ((note % 12) + 12) % 12;
        return pitch == 1 || pitch == 3 || pitch == 6 || pitch == 8 || pitch == 10;
    }

    std::vector<KeyRect> key_rects() const
    {
        std::vector<int> whites;
        std::array<int, 128> white_indices;
        white_indices.fill(-1);
        for (int note = d_first_note; note <= d_last_note; ++note) {
            if (!is_black(note)) {
                white_indices[static_cast<std::size_t>(note)] =
                    static_cast<int>(whites.size());
                whites.push_back(note);
            }
        }
        if (whites.empty())
            return {};

        const double white_width = static_cast<double>(width()) / whites.size();
        const double black_width = white_width * 0.62;
        const double black_height = height() * 0.62;
        std::vector<KeyRect> result;
        result.reserve(static_cast<std::size_t>(d_last_note - d_first_note + 1));
        for (std::size_t i = 0; i < whites.size(); ++i)
            result.push_back({ whites[i],
                               QRectF(i * white_width, 0, white_width, height()),
                               false });
        for (int note = d_first_note; note <= d_last_note; ++note) {
            if (!is_black(note))
                continue;
            int previous = note - 1;
            while (previous >= d_first_note && is_black(previous))
                --previous;
            if (previous < d_first_note ||
                white_indices[static_cast<std::size_t>(previous)] < 0)
                continue;
            const double boundary =
                (white_indices[static_cast<std::size_t>(previous)] + 1) * white_width;
            result.push_back({ note,
                               QRectF(boundary - black_width / 2,
                                      0,
                                      black_width,
                                      black_height),
                               true });
        }
        return result;
    }

    std::optional<int> note_at(const QPointF& point) const
    {
        const auto keys = key_rects();
        for (auto it = keys.rbegin(); it != keys.rend(); ++it) {
            if (it->black && it->rect.contains(point))
                return it->note;
        }
        for (const KeyRect& key : keys) {
            if (!key.black && key.rect.contains(point))
                return key.note;
        }
        return std::nullopt;
    }

    std::optional<int> note_for_key(int key) const
    {
        static constexpr std::array<int, 13> keys{ Qt::Key_A,
                                                   Qt::Key_W,
                                                   Qt::Key_S,
                                                   Qt::Key_E,
                                                   Qt::Key_D,
                                                   Qt::Key_F,
                                                   Qt::Key_T,
                                                   Qt::Key_G,
                                                   Qt::Key_Y,
                                                   Qt::Key_H,
                                                   Qt::Key_U,
                                                   Qt::Key_J,
                                                   Qt::Key_K };
        for (std::size_t i = 0; i < keys.size(); ++i) {
            if (keys[i] != key)
                continue;
            const int note = d_first_note + static_cast<int>(i);
            if (note <= d_last_note)
                return note;
        }
        return std::nullopt;
    }

    void set_mouse_note(std::optional<int> note)
    {
        if (note == d_mouse_note)
            return;
        if (d_mouse_note)
            d_state->release_root(*d_mouse_note);
        d_mouse_note = note;
        if (d_mouse_note)
            d_state->press_root(*d_mouse_note);
        update();
    }

    std::shared_ptr<KeyboardNoteState> d_state;
    int d_first_note;
    int d_last_note;
    std::optional<int> d_mouse_note;
    std::map<int, int> d_keyboard_notes;
    std::map<int, int> d_touch_notes;
};

class SamSonicKeyboardWidget : public QWidget
{
public:
    SamSonicKeyboardWidget(std::shared_ptr<KeyboardNoteState> state,
                           int first_note,
                           int octaves,
                           KeyboardChord initial_chord)
        : d_state(std::move(state))
    {
        d_state->set_selected_chord(initial_chord);
        auto* outer = new QVBoxLayout(this);
        outer->setContentsMargins(8, 6, 8, 8);
        outer->setSpacing(5);

        auto* toolbar = new QHBoxLayout;
        auto* brand = new QLabel(QStringLiteral("SamSonic"), this);
        brand->setStyleSheet(QStringLiteral(
            "font-size:22px; font-weight:800; font-style:italic; color:#ff4fa3;"
            "letter-spacing:1px;"));
        toolbar->addWidget(brand);
        toolbar->addStretch(1);
        auto* chord_label = new QLabel(QStringLiteral("Chord"), this);
        toolbar->addWidget(chord_label);
        auto* chords = new QComboBox(this);
        chords->addItem(QStringLiteral("None"), static_cast<int>(KeyboardChord::None));
        chords->addItem(QStringLiteral("Major triad"),
                        static_cast<int>(KeyboardChord::MajorTriad));
        chords->addItem(QStringLiteral("Minor triad"),
                        static_cast<int>(KeyboardChord::MinorTriad));
        chords->addItem(QStringLiteral("Tritone"),
                        static_cast<int>(KeyboardChord::Tritone));
        chords->addItem(QStringLiteral("Major 7th"),
                        static_cast<int>(KeyboardChord::MajorSeventh));
        chords->addItem(QStringLiteral("Minor 7th"),
                        static_cast<int>(KeyboardChord::MinorSeventh));
        chords->addItem(QStringLiteral("Fully diminished 7th"),
                        static_cast<int>(KeyboardChord::FullyDiminishedSeventh));
        const int initial = chords->findData(static_cast<int>(initial_chord));
        chords->setCurrentIndex(initial >= 0 ? initial : 0);
        QObject::connect(chords,
                         qOverload<int>(&QComboBox::currentIndexChanged),
                         this,
                         [state = d_state, chords](int index) {
                             state->set_selected_chord(static_cast<KeyboardChord>(
                                 chords->itemData(index).toInt()));
                         });
        toolbar->addWidget(chords);
        outer->addLayout(toolbar);

        d_keys = new PianoKeysWidget(d_state, first_note, octaves, this);
        outer->addWidget(d_keys, 1);
        setMinimumSize(540, 195);
        setStyleSheet(QStringLiteral("background:#151823; color:#eef0f7;"));
    }

private:
    std::shared_ptr<KeyboardNoteState> d_state;
    PianoKeysWidget* d_keys = nullptr;
};

class MusicalKeyboardSource : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<MusicalKeyboardSource>;

    static sptr make(double sample_rate,
                     double amplitude,
                     KeyboardWaveform waveform,
                     int first_note,
                     int octaves,
                     double tuning_hz,
                     double attack_ms,
                     double decay_ms,
                     double sustain_level,
                     double release_ms,
                     int unison_voices,
                     double unison_detune_cents,
                     double filter_cutoff_hz,
                     double filter_resonance,
                     double filter_envelope_octaves,
                     double saturation_drive,
                     KeyboardChord initial_chord)
    {
        return gnuradio::make_block_sptr<MusicalKeyboardSource>(sample_rate,
                                                                 amplitude,
                                                                 waveform,
                                                                 first_note,
                                                                 octaves,
                                                                 tuning_hz,
                                                                 attack_ms,
                                                                 decay_ms,
                                                                 sustain_level,
                                                                 release_ms,
                                                                 unison_voices,
                                                                 unison_detune_cents,
                                                                 filter_cutoff_hz,
                                                                 filter_resonance,
                                                                 filter_envelope_octaves,
                                                                 saturation_drive,
                                                                 initial_chord);
    }

    MusicalKeyboardSource(double sample_rate,
                          double amplitude,
                          KeyboardWaveform waveform,
                          int first_note,
                          int octaves,
                          double tuning_hz,
                          double attack_ms,
                          double decay_ms,
                          double sustain_level,
                          double release_ms,
                          int unison_voices,
                          double unison_detune_cents,
                          double filter_cutoff_hz,
                          double filter_resonance,
                          double filter_envelope_octaves,
                          double saturation_drive,
                          KeyboardChord initial_chord)
        : gr::sync_block("musical_keyboard_source",
                         gr::io_signature::make(0, 0, 0),
                         gr::io_signature::make(1, 1, sizeof(float))),
          d_state(std::make_shared<KeyboardNoteState>()),
          d_synth(sample_rate,
                  amplitude,
                  tuning_hz,
                  attack_ms,
                  decay_ms,
                  sustain_level,
                  release_ms,
                  waveform,
                  unison_voices,
                  unison_detune_cents,
                  filter_cutoff_hz,
                  filter_resonance,
                  filter_envelope_octaves,
                  saturation_drive),
          d_widget(new SamSonicKeyboardWidget(
              d_state, first_note, octaves, initial_chord))
    {
    }

    QWidget* qwidget() const { return d_widget; }

    void set_amplitude(double value) { d_synth.set_amplitude(value); }
    void set_tuning_hz(double value) { d_synth.set_tuning_hz(value); }
    void set_attack_ms(double value) { d_synth.set_attack_ms(value); }
    void set_decay_ms(double value) { d_synth.set_decay_ms(value); }
    void set_sustain_level(double value) { d_synth.set_sustain_level(value); }
    void set_release_ms(double value) { d_synth.set_release_ms(value); }
    void set_unison_voices(double value) { d_synth.set_unison_voices(value); }
    void set_unison_detune_cents(double value)
    {
        d_synth.set_unison_detune_cents(value);
    }
    void set_filter_cutoff_hz(double value) { d_synth.set_filter_cutoff_hz(value); }
    void set_filter_resonance(double value) { d_synth.set_filter_resonance(value); }
    void set_filter_envelope_octaves(double value)
    {
        d_synth.set_filter_envelope_octaves(value);
    }
    void set_saturation_drive(double value) { d_synth.set_saturation_drive(value); }

    bool stop() override
    {
        d_state->release_all();
        return gr::sync_block::stop();
    }

    int work(int noutput_items,
             gr_vector_const_void_star&,
             gr_vector_void_star& output_items) override
    {
        auto* output = static_cast<float*>(output_items[0]);
        d_synth.render(output, noutput_items, d_state->snapshot());
        return noutput_items;
    }

private:
    std::shared_ptr<KeyboardNoteState> d_state;
    MusicalKeyboardSynth d_synth;
    SamSonicKeyboardWidget* d_widget;
};

} // namespace grworld
