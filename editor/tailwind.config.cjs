/** @type {import('tailwindcss').Config} */
// Started as IQEngine's client/tailwind.config.js -- the recording view's
// styling is entirely tailwind + daisyui, so its theme has to come along with
// it. Only the vendored viewer is scanned; the editor's own chrome is plain CSS
// in index.html and must not be swept into this stylesheet.
//
// The colors, though, are the editor's, not IQEngine's: the viewer is framed
// inside the editor and has to read as the same application, so every value
// below is lifted from editor/index.html. Anything that changes there should
// change here too. The mapping:
//
//   base-100   #20232f  panel background (.recording-pane, .dlg)
//   base-200   #1b1e29  recessed surface (#workspaceTabs, .paltab)
//   base-300   #333a4d  dividers and panel borders
//   neutral    #2f3650  button fill
//   secondary  #46507a  button/dialog border
//   primary    #3fae63  green accent (Run, active palette tab, toggles)
//   accent     #58a6ff  blue accent (active workspace tab, links)
//
// The extend.colors below are editor chrome colors daisyUI has no token for.
module.exports = {
  content: ['./src/recording/**/*.{js,jsx,ts,tsx}', './recording/index.html'],
  theme: {
    screens: {
      sm: '375px',
      md: '912px',
      lg: '1180px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        field: '#171a24', // input background (.dlgrow input)
        line: '#3a4366', // input border
        raised: '#2a2f42', // hover surface (.menu-top:hover, .cat-row:hover)
        selected: '#38415f', // selected/menu-hover surface (.ctxitem:hover)
        muted: '#9aa7c6', // secondary label text (.dlgrow label)
      },
    },
  },
  daisyui: {
    themes: [
      {
        mytheme: {
          primary: '#3fae63',
          'primary-content': '#0f1420',
          secondary: '#46507a',
          'secondary-content': '#e6e9f0',
          accent: '#58a6ff',
          'accent-content': '#0f1420',
          neutral: '#2f3650',
          'neutral-content': '#e6e9f0',
          'base-100': '#20232f',
          'base-200': '#1b1e29',
          'base-300': '#333a4d',
          'base-content': '#e6e9f0',
          info: '#58a6ff',
          success: '#3fae63',
          warning: '#c9903a',
          error: '#ff7b72',
        },
      },
    ],
  },
  plugins: [require('daisyui')],
};
