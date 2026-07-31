// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

// The editor's chrome font (editor/index.html), which the viewer's DOM picks up
// from the base rules in features/ui/styles/tailwind_index.css. Text drawn on a
// canvas -- konva labels on the spectrogram, the plot axes in
// features/ui/canvas-plot -- inherits nothing from CSS, so it names them here.
export const APP_FONT_FAMILY = 'system-ui, Arial, sans-serif';
export const APP_FONT_SIZE = 13;

export const MINIMUM_SCROLL_HANDLE_HEIGHT_PIXELS = 10;
export const COLORMAP_DEFAULT = 'viridis';
export const MINIMAP_FFT_SIZE = 64;
export const FETCH_PADDING = 50; // how many extra ffts we fetch, in order to smooth scrolling
export const MIN_SPECTROGRAM_HEIGHT = 650;
export const INITIAL_METADATA_SNIPPET = `{
    "global": {
        "core:datatype": "cf32_le",
        "core:sample_rate": 1000000,
        "core:hw": "PlutoSDR with 915 MHz whip antenna",
        "core:author": "Art Vandelay",
        "core:version": "1.0.0"
    },
    "captures": [
        {
            "core:sample_start": 0,
            "core:frequency": 915000000
        }
    ],
    "annotations": []
}`;
export const INITIAL_ANNOTATIONS_SNIPPET = `{
    "annotations": [{
        "core:sample_start": 100000,
        "core:sample_count": 200000,
        "core:freq_lower_edge": 883275000,
        "core:freq_upper_edge": 884625000,
        "core:label": "LTE"
    }]
}`;
