// site/styles.css is generated from the class names used in site/index.html.
// Netlify rebuilds it on every deploy; run `npm run build` to refresh the committed copy.
module.exports = {
    content: ['./site/index.html'],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
                mono: ['JetBrains Mono', 'monospace'],
            },
            colors: {
                gym: {
                    50: '#ecfdf5',
                    100: '#d1fae5',
                    400: '#34d399',
                    500: '#10b981',
                    600: '#059669',
                    700: '#047857',
                },
                hiit: {
                    400: '#fb923c',
                    500: '#f97316',
                    600: '#ea580c',
                }
            }
        }
    }
};
