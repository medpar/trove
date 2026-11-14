#!/usr/bin/env python3
"""Build Trove's Apple Shortcuts (iPhone, iPad, Mac).

  Save to Trove      Share sheet, Mac Share menu, Services and Quick Actions. Saves instantly, then
                     notifies. Run with no input (widget, Siri, Action Button) it saves the clipboard.
  Save to Trove…     The same, but first asks for a collection (from /api/stats), tags and a note.
  Trove Quick Save   Saves whatever is on the clipboard: for the Action Button, Back Tap, Control
                     Center, the Lock Screen, Siri and a Mac keyboard shortcut.
  Trove Note         Asks for text (dictation works) and saves it as a note.

Files and images go to POST /api/files (multipart, up to 4 MB); links and text to POST /api/items.
Each shortcut asks for the API key once at install time (an import question), so the published files
contain no secret. The base URL is baked in.

Usage:
  python3 scripts/make-shortcut.py [BASE_URL] [OUT] [--no-sign]
    BASE_URL   default https://trove.mariomedpar.com
    OUT        default web/public/trove.shortcut ("Save to Trove"); the others, and a copy of it,
               go to <OUT dir>/shortcuts/
    --no-sign  write unsigned plists instead. Signing needs macOS:
               shortcuts sign --mode anyone --input unsigned.shortcut --output signed.shortcut
"""
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

args = [a for a in sys.argv[1:] if not a.startswith('--')]
SIGN = '--no-sign' not in sys.argv
BASE = (args[0] if args else 'https://trove.mariomedpar.com').rstrip('/')
OUT = args[1] if len(args) > 1 else os.path.join(os.path.dirname(__file__), '..', 'web', 'public', 'trove.shortcut')
OUT_DIR = os.path.join(os.path.dirname(OUT) or '.', 'shortcuts')

OBJ = '\ufffc'  # placeholder for a variable inside a text field

# If conditions
IS, BEGINS_WITH, CONTAINS, NOT_CONTAINS, HAS_VALUE, NO_VALUE = 4, 8, 99, 999, 100, 101

# Get Type names of file-like items (English and Spanish). Text-like types are compared against the
# names the device itself reports at run time, so that check works in any language.
FILE_TYPES = '|Image|Imagen|PDF|File|Archivo|Media|Contenido|'
# Collections Trove fills itself; the collection picker hides them.
AUTO_COLLECTIONS = r'(?m)^(?!(?:Browser bookmarks|X bookmarks|Pinterest)(?:/|$)).+$'
# How a JSON false may read as text; anything else counts as newly saved.
FALSY = ['0', 'false', 'False', 'FALSE', 'No', 'no', 'NO']


_ids = {'scope': '', 'n': 0}


def uid():
    """Stable UUIDs (per shortcut name and position), so rebuilding gives the same file."""
    _ids['n'] += 1
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'trove-shortcut:{_ids["scope"]}:{_ids["n"]}')).upper()


class Out:
    """The output of an action, usable as a magic variable."""

    def __init__(self, id, name):
        self.id, self.name = id, name

    def att(self):
        return {'Type': 'ActionOutput', 'OutputName': self.name, 'OutputUUID': self.id}


def var(name):
    return {'Type': 'Variable', 'VariableName': name}


SHORTCUT_INPUT = {'Type': 'ExtensionInput'}
REPEAT_ITEM = var('Repeat Item')


def att(x):
    return x.att() if isinstance(x, Out) else x


def text(*parts):
    """A text field mixing literal strings and variables."""
    s, atts = '', {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            atts[f'{{{len(s.encode("utf-16-le")) // 2}, 1}}'] = att(p)  # NSRange counts UTF-16 units
            s += OBJ
    return {'Value': {'string': s, 'attachmentsByRange': atts}, 'WFSerializationType': 'WFTextTokenString'}


def ref(x):
    """A parameter that takes a single variable."""
    return {'Value': att(x), 'WFSerializationType': 'WFTextTokenAttachment'}


def fields(*items):
    return {'Value': {'WFDictionaryFieldValueItems': list(items)}, 'WFSerializationType': 'WFDictionaryFieldValue'}


def text_field(key, *parts):
    return {'WFItemType': 0, 'WFKey': text(key), 'WFValue': text(*parts)}


def file_field(key, x):
    return {'WFItemType': 5, 'WFKey': text(key), 'WFValue': {'Value': att(x), 'WFSerializationType': 'WFTokenAttachmentParameterState'}}


class Shortcut:
    def __init__(self, name):
        self.name = name
        self.actions = []
        _ids.update(scope=name, n=0)
        # Action 0 holds the API key; the import question fills it in.
        self.key = self.add('gettext', {'WFTextActionText': ''}, 'Text')

    def add(self, ident, params=None, output=None):
        p = dict(params or {})
        out = None
        if output:
            p['UUID'] = uid()
            out = Out(p['UUID'], output)
        self.actions.append({'WFWorkflowActionIdentifier': f'is.workflow.actions.{ident}', 'WFWorkflowActionParameters': p})
        return out

    # control flow
    def if_(self, subject, condition, value=None):
        g = uid()
        p = {'GroupingIdentifier': g, 'WFControlFlowMode': 0, 'WFCondition': condition, 'WFInput': {'Type': 'Variable', 'Variable': ref(subject)}}
        if value is not None:
            p['WFConditionalActionString'] = value if isinstance(value, dict) else text(value)
        self.add('conditional', p)
        return g

    def otherwise(self, g):
        self.add('conditional', {'GroupingIdentifier': g, 'WFControlFlowMode': 1})

    def end_if(self, g):
        self.add('conditional', {'GroupingIdentifier': g, 'WFControlFlowMode': 2, 'UUID': uid()})

    def repeat_each(self, items):
        g = uid()
        self.add('repeat.each', {'GroupingIdentifier': g, 'WFControlFlowMode': 0, 'WFInput': ref(items)})
        return g

    def end_repeat(self, g):
        out = Out(uid(), 'Repeat Results')
        self.add('repeat.each', {'GroupingIdentifier': g, 'WFControlFlowMode': 2, 'UUID': out.id})
        return out

    # actions
    def text(self, *parts):
        return self.add('gettext', {'WFTextActionText': text(*parts)}, 'Text')

    def set(self, name, x):
        self.add('setvariable', {'WFVariableName': name, 'WFInput': ref(x)})

    def set_text(self, name, s):
        self.set(name, self.text(s))

    def append(self, name, x):
        self.add('appendvariable', {'WFVariableName': name, 'WFInput': ref(x)})

    def value(self, d, key):
        return self.add('getvalueforkey', {'WFInput': ref(d), 'WFGetDictionaryValueType': 'Value', 'WFDictionaryKey': key}, 'Dictionary Value')

    def type_of(self, x):
        return self.add('getitemtype', {'WFInput': ref(x)}, 'Type')

    def first(self, x):
        return self.add('getitemfromlist', {'WFInput': ref(x), 'WFItemSpecifier': 'First Item'}, 'Item from List')

    def ask(self, prompt, multiline=False):
        return self.add('ask', {'WFAskActionPrompt': prompt, 'WFInputType': 'Text', 'WFAskActionDefaultAnswer': '', 'WFAllowsMultilineText': multiline}, 'Provided Input')

    def notify(self, title, *body, sound=False):
        self.add('notification', {'WFNotificationActionTitle': text(title), 'WFNotificationActionBody': text(*body), 'WFNotificationActionSound': sound})

    def headers(self, json=False):
        items = [text_field('Authorization', 'Bearer ', self.key)]
        if json:
            items.append(text_field('Content-Type', 'application/json'))
        return fields(*items)

    def get(self, path):
        return self.add('downloadurl', {'WFURL': BASE + path, 'WFHTTPMethod': 'GET', 'ShowHeaders': True, 'WFHTTPHeaders': self.headers()}, 'Contents of URL')

    def post_json(self, path, *items):
        return self.add(
            'downloadurl',
            {'WFURL': BASE + path, 'WFHTTPMethod': 'POST', 'ShowHeaders': True, 'WFHTTPHeaders': self.headers(json=True), 'WFHTTPBodyType': 'JSON', 'WFJSONValues': fields(*items)},
            'Contents of URL',
        )

    def post_form(self, path, *items):
        return self.add(
            'downloadurl',
            {'WFURL': BASE + path, 'WFHTTPMethod': 'POST', 'ShowHeaders': True, 'WFHTTPHeaders': self.headers(), 'WFHTTPBodyType': 'Form', 'WFFormValues': fields(*items)},
            'Contents of URL',
        )


# ---- building blocks shared by the shortcuts ----


def report(sc, response):
    """Notify "Saved: <title>" / "Already in Trove: <title>", or the error."""
    item = sc.value(response, 'item')
    ok = sc.if_(item, HAS_VALUE)
    title = sc.value(item, 'title')
    created = sc.value(response, 'created')
    # `created` is a JSON boolean; look its text up instead of guessing how Shortcuts prints it.
    labels = sc.add('dictionary', {'WFItems': fields(*[text_field(k, 'Already in Trove') for k in FALSY])}, 'Dictionary')
    label = sc.value(labels, text(created))
    known = sc.if_(label, HAS_VALUE)
    sc.set('Trove Status', label)
    sc.otherwise(known)
    sc.set_text('Trove Status', 'Saved')
    sc.end_if(known)
    sc.notify('Trove', var('Trove Status'), ': ', title)
    sc.otherwise(ok)
    error = sc.value(response, 'error')
    has_error = sc.if_(error, HAS_VALUE)
    sc.notify('Couldn’t save to Trove', error, sound=True)
    sc.otherwise(has_error)
    sc.notify('Couldn’t save to Trove', 'Check the API key and the connection. Files can be up to 4 MB.', sound=True)
    sc.end_if(has_error)
    sc.end_if(ok)


def input_or_clipboard(sc):
    """Input = the share sheet input, or the clipboard when there is none."""
    g = sc.if_(SHORTCUT_INPUT, HAS_VALUE)
    sc.set('Input', SHORTCUT_INPUT)
    sc.otherwise(g)
    sc.set('Input', sc.add('getclipboard', {}, 'Clipboard'))
    sc.end_if(g)


def stop_if_empty(sc):
    g = sc.if_(var('Input'), NO_VALUE)
    sc.notify('Nothing to save', 'Share something to Trove, or copy it first.')
    sc.add('exit')
    sc.end_if(g)


def classify(sc):
    """Kind = text | url | file. Link = the URL(s) when Kind is url."""
    sc.set_text('Kind', 'file')
    kind = sc.type_of(var('Input'))
    # Get Type is localized, so compare with what this device calls plain and rich text.
    sample = sc.text('Trove')
    rich = sc.add('getrichtextfrommarkdown', {'WFInput': ref(sample)}, 'Rich Text from Markdown')
    text_types = sc.text('|', sc.type_of(sample), '|', sc.type_of(rich), '|')
    is_text = sc.if_(text_types, CONTAINS, text('|', kind, '|'))
    sc.set_text('Kind', 'text')
    sc.otherwise(is_text)
    files = sc.text(FILE_TYPES)
    not_file = sc.if_(files, NOT_CONTAINS, text('|', kind, '|'))
    # URLs, Safari web pages, articles (and anything unknown that carries a web link)
    links = sc.add('detect.link', {'WFInput': ref(var('Input'))}, 'URLs')
    sc.set('Link', links)
    is_link = sc.if_(links, BEGINS_WITH, 'http')
    sc.set_text('Kind', 'url')
    sc.end_if(is_link)
    sc.end_if(not_file)
    sc.end_if(is_text)


def save(sc, extra=()):
    """Save Input according to Kind, then notify."""
    extra = [text_field('source', 'Shortcut'), *extra]
    is_file = sc.if_(var('Kind'), IS, 'file')
    each = sc.repeat_each(var('Input'))  # several photos or files: one request (and notification) each
    report(sc, sc.post_form('/api/files', file_field('file', REPEAT_ITEM), *extra))
    sc.end_repeat(each)
    sc.otherwise(is_file)
    is_url = sc.if_(var('Kind'), IS, 'url')
    sc.set('Response', sc.post_json('/api/items', text_field('url', sc.first(var('Link'))), *extra))
    sc.otherwise(is_url)
    sc.set('Response', sc.post_json('/api/items', text_field('text', var('Input')), *extra))
    sc.end_if(is_url)
    # (Not a shared loop over responses: Repeat with Each over one dictionary walks its keys.)
    report(sc, var('Response'))
    sc.end_if(is_file)


def ask_details(sc):
    """Collection (picked from /api/stats, None or New…), tags and note -> form/JSON fields."""
    stats = sc.get('/api/stats')
    each = sc.repeat_each(sc.value(stats, 'collections'))
    sc.value(REPEAT_ITEM, 'name')
    names = sc.end_repeat(each)
    # Hide the collections Trove fills itself (browser bookmarks, X bookmarks, Pinterest).
    listing = sc.text(names)
    mine = sc.add('text.match', {'WFMatchTextPattern': AUTO_COLLECTIONS, 'WFMatchTextCaseSensitive': False, 'text': text(listing)}, 'Matches')
    sc.append('Collections', sc.text('None'))
    sc.append('Collections', sc.text('New…'))
    sc.append('Collections', mine)
    chosen = sc.add('choosefromlist', {'WFInput': ref(var('Collections')), 'WFChooseFromListActionPrompt': 'Collection'}, 'Chosen Item')
    none = sc.if_(chosen, IS, 'None')
    sc.set_text('Collection', '')
    # "None" means keep it unsorted: don't let AI file it.
    sc.set_text('Autofile', 'false')
    sc.otherwise(none)
    sc.set_text('Autofile', '')
    new = sc.if_(chosen, IS, 'New…')
    sc.set('Collection', sc.ask('New collection (use / to nest, e.g. Design/Ideas)'))
    sc.otherwise(new)
    sc.set('Collection', chosen)
    sc.end_if(new)
    sc.end_if(none)
    tags = sc.ask('Tags (comma separated, optional)')
    note = sc.ask('Note (optional)', multiline=True)
    return [text_field('collection', var('Collection')), text_field('tags', tags), text_field('note', note), text_field('autofile', var('Autofile'))]


# ---- the shortcuts ----

SHARE_INPUT = [
    'WFURLContentItem',
    'WFSafariWebPageContentItem',
    'WFArticleContentItem',
    'WFStringContentItem',
    'WFRichTextContentItem',
    'WFImageContentItem',
    'WFPDFContentItem',
    'WFGenericFileContentItem',
    'WFAVAssetContentItem',
]


def save_to_trove():
    sc = Shortcut('Save to Trove')
    input_or_clipboard(sc)
    stop_if_empty(sc)
    classify(sc)
    save(sc)
    return sc, {'color': 4282601983, 'types': ['ActionExtension', 'QuickActions', 'MenuBar'], 'input': SHARE_INPUT}


def save_with_details():
    sc = Shortcut('Save to Trove…')
    input_or_clipboard(sc)
    stop_if_empty(sc)
    extra = ask_details(sc)
    classify(sc)
    save(sc, extra)
    return sc, {'color': 2071128575, 'types': ['ActionExtension', 'QuickActions', 'MenuBar'], 'input': SHARE_INPUT}


def quick_save():
    sc = Shortcut('Trove Quick Save')
    sc.set('Input', sc.add('getclipboard', {}, 'Clipboard'))
    g = sc.if_(var('Input'), NO_VALUE)
    sc.notify('Nothing to save', 'Copy a link, some text or an image first.')
    sc.add('exit')
    sc.end_if(g)
    classify(sc)
    save(sc)
    return sc, {'color': 4271458815, 'types': ['MenuBar'], 'input': None}


def note():
    sc = Shortcut('Trove Note')
    body = sc.ask('Note', multiline=True)
    report(sc, sc.post_json('/api/items', text_field('text', body), text_field('source', 'Shortcut')))
    return sc, {'color': 4292093695, 'types': ['MenuBar', 'WatchKit'], 'input': None}


def workflow(sc, o):
    w = {
        'WFWorkflowClientVersion': '2605.0.5',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowName': sc.name,
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': o['color'], 'WFWorkflowIconGlyphNumber': 59511},
        'WFWorkflowTypes': o['types'],
        'WFWorkflowImportQuestions': [
            {
                'ActionIndex': 0,
                'Category': 'Parameter',
                'DefaultValue': '',
                'ParameterKey': 'WFTextActionText',
                'Text': 'Paste your Trove API key (Trove → Settings → API keys → copy the “Shortcut” key).',
            }
        ],
        'WFWorkflowActions': sc.actions,
        'WFWorkflowOutputContentItemClasses': [],
    }
    if o['input']:
        w.update(
            {
                'WFWorkflowHasShortcutInputVariables': True,
                'WFWorkflowInputContentItemClasses': o['input'],
                'WFQuickActionSurfaces': ['Finder', 'Services'],
                'WFWorkflowNoInputBehavior': {'Name': 'WFWorkflowNoInputBehaviorGetClipboard', 'Parameters': {}},
            }
        )
    else:
        w.update({'WFWorkflowHasShortcutInputVariables': False, 'WFWorkflowInputContentItemClasses': [], 'WFQuickActionSurfaces': []})
    return w


def build(path, sc, o, tmp):
    unsigned = os.path.join(tmp, os.path.basename(path))
    with open(unsigned, 'wb') as f:
        plistlib.dump(workflow(sc, o), f, fmt=plistlib.FMT_BINARY)
    subprocess.run(['plutil', '-lint', '-s', unsigned], check=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if SIGN:
        # Signing goes through Apple's servers, which sometimes answer with a transient error.
        for attempt in range(4):
            r = subprocess.run(['shortcuts', 'sign', '--mode', 'anyone', '--input', unsigned, '--output', path], capture_output=True, text=True)
            if r.returncode == 0 and os.path.getsize(path):
                break
            print(f'  signing {os.path.basename(path)} failed: {(r.stderr or r.stdout).strip()}', file=sys.stderr)
            time.sleep(3 * (attempt + 1))
        else:
            sys.exit(f'Could not sign {path}')
    else:
        shutil.copyfile(unsigned, path)
    print(f'{shown(path)}  ({sc.name}, {len(sc.actions)} actions, {"signed" if SIGN else "unsigned"})')


def shown(path):
    rel = os.path.relpath(path)
    return path if rel.startswith('..') else rel


def main():
    out, out_dir = os.path.normpath(OUT), os.path.normpath(OUT_DIR)
    with tempfile.TemporaryDirectory() as tmp:
        build(out, *save_to_trove(), tmp)
        copy = os.path.join(out_dir, 'Save to Trove.shortcut')
        os.makedirs(out_dir, exist_ok=True)
        shutil.copyfile(out, copy)
        print(f'{shown(copy)}  (copy of {os.path.basename(out)})')
        build(os.path.join(out_dir, 'Save to Trove with Details.shortcut'), *save_with_details(), tmp)
        build(os.path.join(out_dir, 'Trove Quick Save.shortcut'), *quick_save(), tmp)
        build(os.path.join(out_dir, 'Trove Note.shortcut'), *note(), tmp)


if __name__ == '__main__':
    main()
