// The little display that says how far into a recording a file source has read.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The three recording blocks -- SigMF Source, GR World Recording, Public HTTP
// Recording -- are each one BrowserFileSource, and each of their factories
// attaches one of these unless the block's `progress` parameter says otherwise.
// File Source is the one that does not: it is upstream's block, and its .grc has
// to stay one native GNU Radio reads. See docs/recording-viewer.md.
//
// Driven by a QTimer rather than by the stream, for the same reason
// PacketRateSinkWasm is: a display repainted only when samples arrive freezes on
// its last value when they stop, which is exactly when the reader most wants to
// know what happened.
#pragma once

#include "browser_file_source.hpp"

#include <QFontMetrics>
#include <QLabel>
#include <QLocale>
#include <QPointer>
#include <QProgressBar>
#include <QString>
#include <QStringList>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>
#include <cmath>
#include <memory>
#include <string>

namespace file_progress {

// 1_234_567 -> "1.23 M". Samples run to the billions and the widget is one row
// tall, so the full digit string is spelled out in the tooltip instead.
inline QString abbreviate_items(double items)
{
    static const char* kSuffix[] = { "", " k", " M", " G", " T" };
    int step = 0;
    while (items >= 1000.0 && step < 4) {
        items /= 1000.0;
        ++step;
    }
    const int decimals = step == 0 ? 0 : (items < 10.0 ? 2 : items < 100.0 ? 1 : 0);
    return QString::number(items, 'f', decimals) + QString::fromLatin1(kSuffix[step]);
}

// Seconds with a resolution that stays useful across the range a recording can
// span: a 3 ms capture and a 40 minute one both have to read sensibly.
inline QString format_seconds(double seconds)
{
    if (!(seconds > 0.0))
        return QStringLiteral("0 s");
    if (seconds < 1.0)
        return QString::number(seconds * 1000.0, 'f', seconds < 0.01 ? 2 : 1) +
               QStringLiteral(" ms");
    if (seconds < 60.0)
        return QString::number(seconds, 'f', seconds < 10.0 ? 2 : 1) +
               QStringLiteral(" s");
    const auto total = static_cast<long long>(seconds);
    return QStringLiteral("%1:%2")
        .arg(total / 60)
        .arg(total % 60, 2, 10, QLatin1Char('0'));
}

inline QString with_thousands(std::uint64_t value)
{
    return QLocale::system().toString(static_cast<qulonglong>(value));
}

} // namespace file_progress

class FileProgressWidget : public QWidget
{
public:
    // `label` is what the reader called this recording (a file name, a bucket
    // key, a URL's last segment). `sample_rate` is the recording's own, and 0
    // where the recording does not carry one -- a raw file has no metadata to
    // say, and guessing from the flowgraph would be a guess -- in which case the
    // display counts in samples alone rather than inventing a duration.
    FileProgressWidget(std::shared_ptr<BrowserFileSource> source,
                       const QString& label,
                       double sample_rate)
        : d_label(label),
          d_source(source),
          d_sample_rate(sample_rate > 0.0 ? sample_rate : 0.0),
          d_path(QString::fromStdString(source->path()))
    {
        // A plain widget rather than a QGroupBox: the box spends a whole row on
        // its title and then draws a rule under it, which is a lot of furniture
        // around two lines of text. The recording's name leads the text line
        // instead.
        auto* layout = new QVBoxLayout(this);
        layout->setContentsMargins(6, 2, 6, 2);
        layout->setSpacing(2);
        // A tile is whatever height the reader dragged it to, and the bar and
        // its caption are a fixed height: centre them rather than leaving the
        // pair stranded at the top of a tile dragged taller.
        layout->addStretch(1);

        d_bar = new QProgressBar(this);
        d_bar->setRange(0, 1000);   // tenths of a percent: a long file still moves
        d_bar->setMaximumHeight(QFontMetrics(font()).height() + 6);
        layout->addWidget(d_bar);

        d_text = new QLabel(this);
        d_text->setAlignment(Qt::AlignCenter);
        d_text->setTextInteractionFlags(Qt::TextSelectableByMouse);
        layout->addWidget(d_text);
        layout->addStretch(1);

        setMinimumWidth(220);
        tick();

        // Parented to this widget, so it lives and dies on the GUI thread.
        auto* timer = new QTimer(this);
        QObject::connect(timer, &QTimer::timeout, this, [this] { tick(); });
        timer->start(kUpdateMs);
    }

private:
    static constexpr int kUpdateMs = 200;

    void tick()
    {
        // The run ended and the block is gone: leave the last reading on screen
        // rather than blanking it. Weak, because the widget outlives the block
        // by however long it takes run_now() to get to its deleteLater().
        const auto source = d_source.lock();
        if (!source)
            return;
        const BrowserFileSource::Progress p = source->progress();
        const double position = static_cast<double>(p.position);
        const double length = static_cast<double>(p.length);
        const double fraction = length > 0.0 ? position / length : 0.0;

        d_bar->setValue(static_cast<int>(std::lround(fraction * 1000.0)));
        d_bar->setFormat(QString::number(fraction * 100.0, 'f', 1) +
                         QStringLiteral("%"));

        QStringList parts;
        parts << d_label;
        if (d_sample_rate > 0.0)
            parts << (file_progress::format_seconds(position / d_sample_rate) +
                      QStringLiteral(" / ") +
                      file_progress::format_seconds(length / d_sample_rate));
        parts << (file_progress::abbreviate_items(position) +
                  QStringLiteral(" / ") +
                  file_progress::abbreviate_items(length) + QStringLiteral("S"));

        if (p.passes > 0)
            parts << QStringLiteral("pass %1").arg(p.passes + 1);

        // A tile is as wide as the reader made it, and a QLabel given more text
        // than it has room for simply cuts it off at the edge -- which looks
        // like a display that stops mid-word rather than one that ran out of
        // space. Elide instead, so the truncation is visible and says so.
        const QString text = parts.join(QStringLiteral(" · "));
        const int room = d_text->width();
        d_text->setText(room > 40 ? d_text->fontMetrics().elidedText(
                                        text, Qt::ElideRight, room)
                                  : text);

        setToolTip(tooltip(p, text));
    }

    QString tooltip(const BrowserFileSource::Progress& p,
                    const QString& caption) const
    {
        QStringList lines;
        // The caption in full, since the tile may have been too narrow for it.
        lines << caption;
        lines << d_path;
        lines << QStringLiteral("sample %1 of %2, from offset %3, %4 bytes each "
                                "(%5 bytes in)")
                     .arg(file_progress::with_thousands(p.position),
                          file_progress::with_thousands(p.length),
                          file_progress::with_thousands(p.offset),
                          QString::number(static_cast<qulonglong>(p.item_size)),
                          file_progress::with_thousands(
                              (p.offset + p.position) * p.item_size));
        lines << (d_sample_rate > 0.0
                      ? QStringLiteral("recorded at %1S/s, which is what the "
                                       "seconds are counted against")
                            .arg(file_progress::abbreviate_items(d_sample_rate))
                      : QStringLiteral("this recording declares no sample rate, "
                                       "so there are no seconds to show"));
        // The bar leads the plots: the source has read this far, and the
        // samples are still working their way down the graph's buffers.
        lines << QStringLiteral("this is what the source has read, which runs "
                                "slightly ahead of what the plots show");
        return lines.join(QLatin1Char('\n'));
    }

    const QString d_label;
    std::weak_ptr<BrowserFileSource> d_source;
    const double d_sample_rate;
    const QString d_path;
    QPointer<QProgressBar> d_bar;
    QPointer<QLabel> d_text;
};
