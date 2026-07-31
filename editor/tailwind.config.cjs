/** @type {import('tailwindcss').Config} */
// Copied from IQEngine's client/tailwind.config.js -- the recording view's
// styling is entirely tailwind + daisyui, so its theme has to come along with
// it. Only the vendored viewer is scanned; the editor's own chrome is plain CSS
// in index.html and must not be swept into this stylesheet.
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
  },
  daisyui: {
    themes: [
      {
        mytheme: {
          primary: '#4CE091',
          secondary: '#136f63',
          accent: '#84cae7',
          neutral: '#0f172a',
          'base-100': '#05041C',
          'base-content': '#f4f4f5',
        },
      },
    ],
  },
  plugins: [require('daisyui')],
};
