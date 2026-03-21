import re

with open(r'g:\My Drive\Code\portfolio-site\private.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: Replace old scheduleGenerateComicPages + generateComicPages with stubs
pattern = r'(        let _genDebounce = null;\n        window\.scheduleGenerateComicPages = \(\) => \{.*?\n        \};)\n\n        (window\.generateComicPages = async \(\) => \{.*?\n        \};)'
stub = '        let _genDebounce = null;\n        window.scheduleGenerateComicPages = () => {};\n        window.generateComicPages = async () => {};'
result, n = re.subn(pattern, stub, content, flags=re.DOTALL)
print(f'Fix 1: {n} replacements')

# Fix 2: Remove the dangling old fetchComicPages body
# It lives between the new stub line and the /* Comic reader */ comment
marker_start = '// fetchComicPages is no longer in the modal'
if marker_start in result:
    idx_s = result.find(marker_start)
    end_marker = '\n\n        /* \u2500\u2500 Comic reader \u2500\u2500 */'
    idx_e = result.find(end_marker, idx_s)
    if idx_e >= 0:
        old_chunk = result[idx_s:idx_e]
        new_chunk = 'window.fetchComicPages = async () => {};'
        result = result[:idx_s] + new_chunk + result[idx_e:]
        print(f'Fix 2: removed {len(old_chunk)} chars')
    else:
        # Try without the leading newlines
        end_marker2 = '        /* \u2500\u2500 Comic reader \u2500\u2500 */'
        idx_e2 = result.find(end_marker2, idx_s)
        if idx_e2 >= 0:
            old_chunk = result[idx_s:idx_e2]
            new_chunk = 'window.fetchComicPages = async () => {};\n\n        '
            result = result[:idx_s] + new_chunk + result[idx_e2:]
            print(f'Fix 2 alt: removed {len(old_chunk)} chars')
        else:
            print('Fix 2: markers not found')
            print(repr(result[idx_s:idx_s+400]))
else:
    # Stub already in place, but dangling body may follow
    stub_marker = "window.fetchComicPages = async () => {};"
    idx_stub = result.find(stub_marker)
    if idx_stub >= 0:
        after_stub = idx_stub + len(stub_marker)
        # Find the Comic reader comment which marks the end of the dangling block
        end_mark = '/* \u2500\u2500 Comic reader \u2500\u2500 */'
        idx_e = result.find(end_mark, after_stub)
        if idx_e >= 0:
            dangling = result[after_stub:idx_e]
            result = result[:after_stub] + '\n\n        ' + result[idx_e:]
            print(f'Fix 2: removed {len(dangling)} chars of dangling body')
        else:
            print('Fix 2: comic reader marker not found after stub')
            print(repr(result[after_stub:after_stub+300]))
    else:
        print('Fix 2: stub not found either')
        idx = result.find('fetchComicPages')
        print(repr(result[idx:idx+200]) if idx >= 0 else 'not found at all')

with open(r'g:\My Drive\Code\portfolio-site\private.html', 'w', encoding='utf-8') as f:
    f.write(result)
print('Saved.')
