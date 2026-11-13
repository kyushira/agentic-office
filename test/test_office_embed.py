"""embed.css is injected into the built office page and hides the chat column under 900px."""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "plugin", "agent-office", "office-build")


def read(name):
    with open(os.path.join(BUILD, name), encoding="utf-8") as f:
        return f.read()


def media_blocks(css, max_width):
    """Return the body of each @media (max-width: N px) block with that N."""
    out = []
    for m in re.finditer(r"@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{", css):
        if int(m.group(1)) != max_width:
            continue
        depth, i = 1, m.end()
        while depth and i < len(css):
            depth += {"{": 1, "}": -1}.get(css[i], 0)
            i += 1
        out.append(css[m.end():i - 1])
    return out


def rules(body):
    """Map selector -> declarations text for a flat block of rules."""
    out = {}
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    for sels, decl in re.findall(r"([^{}]+)\{([^{}]*)\}", body):
        for sel in sels.split(","):
            out[sel.strip()] = decl
    return out


class EmbedInjection(unittest.TestCase):
    def test_build_injects_embed_css_into_index_html(self):
        src = read("build-office.mjs")
        self.assertIn("function embedCss()", src)
        self.assertIn("transformIndexHtml", src)
        self.assertIn("readFileSync(join(HERE, 'embed.css')", src)
        self.assertIn("plugins: [officePatch(), embedCss()]", src)
        self.assertIn("html.replace('</head>'", src)

    def test_existing_office_patch_is_still_wired(self):
        src = read("build-office.mjs")
        self.assertIn("officePatch()", src)
        self.assertIn("patchSource(rel, code)", src)


class EmbedCss(unittest.TestCase):
    def setUp(self):
        self.css = read("embed.css")
        blocks = media_blocks(self.css, 899)
        self.assertEqual(len(blocks), 1, "exactly one max-width: 899px block")
        self.r = rules(blocks[0])

    def test_hides_chat_column_under_900px(self):
        self.assertIn(".chat-column", self.r)
        self.assertRegex(self.r[".chat-column"], r"display:\s*none")

    def test_hides_status_strip_under_900px(self):
        self.assertIn(".status-strip", self.r)
        self.assertRegex(self.r[".status-strip"], r"display:\s*none")

    def test_scene_fills_the_frame(self):
        self.assertIn(".office-view", self.r)
        self.assertRegex(self.r[".office-view"], r"flex:\s*1")
        self.assertRegex(self.r[".office-view"], r"width:\s*100%")
        self.assertIn(".app-wrapper", self.r)
        self.assertRegex(self.r[".app-wrapper"], r"width:\s*100%")

    def test_rules_outside_the_media_block_do_not_hide_the_chat(self):
        outside = re.sub(r"@media\s*\(\s*max-width:\s*899px\s*\)\s*\{.*\}", "", self.css, flags=re.S)
        self.assertNotRegex(outside, r"\.chat-column[^{}]*\{[^{}]*display:\s*none")

    def test_selectors_are_cited_to_the_reference_checkout(self):
        for sel in (".app-wrapper", ".app-body", ".office-view", ".chat-column", ".status-strip"):
            self.assertIn(sel, self.css)
        self.assertIn("App.tsx:1823", self.css)
        self.assertIn("StatusStrip.tsx:172", self.css)

    def test_phone_tag_stays_24px(self):
        base = self.r['.char-body-group[data-agent-id^="hermes-"]::before']
        self.assertRegex(base, r"font:\s*600 24px/1")

    def test_desktop_tag_is_smaller_under_the_flag_class(self):
        sel = '.ao-tags-desktop .char-body-group[data-agent-id^="hermes-"]::before'
        self.assertIn(sel, self.r)
        self.assertRegex(self.r[sel], r"font-size:\s*12px")

    def test_main_tsx_patch_sets_the_flag_class(self):
        src = read("office-patch.mjs")
        self.assertIn("'src/main.tsx'", src)
        self.assertIn("params.get('ao-tags') === 'desktop'", src)
        self.assertIn("classList.add('ao-tags-desktop')", src)


if __name__ == "__main__":
    unittest.main()
