"""The files a coding agent names, read from the developer's machine.

Paths are sent relative to the repository root, with the service manifest
above each file, so the index can tell which service a file belongs to.
"""

from dataclasses import dataclass, field
from pathlib import Path

from appcommon.product import manifest_filename

#: The same limits the API enforces.
MAX_FILES = 20
MAX_BYTES = 300_000


@dataclass
class Gathered:
    files: list[dict[str, str]] = field(default_factory=list)
    manifests: list[dict[str, str]] = field(default_factory=list)
    #: Paths that could not be read, and why.
    skipped: list[str] = field(default_factory=list)


def repository_root(start: Path) -> Path:
    """The nearest directory holding .git, or the start itself."""
    for directory in [start, *start.parents]:
        if (directory / '.git').exists():
            return directory
    return start


def gather(paths: list[str], cwd: Path) -> Gathered:
    root = repository_root(cwd.resolve())
    found = Gathered()
    seen_manifests: set[Path] = set()
    for raw in paths[:MAX_FILES]:
        path = (cwd / raw).resolve()
        if not path.is_relative_to(root):
            found.skipped.append(f'{raw}: outside the repository')
            continue
        if not path.is_file():
            found.skipped.append(f'{raw}: no such file')
            continue
        if path.stat().st_size > MAX_BYTES:
            found.skipped.append(f'{raw}: larger than {MAX_BYTES // 1000} kB')
            continue
        found.files.append(
            {'path': path.relative_to(root).as_posix(), 'content': path.read_text(errors='replace')}
        )
        for directory in [path.parent, *path.parent.parents]:
            manifest = directory / manifest_filename()
            if manifest.is_file():
                if manifest not in seen_manifests:
                    seen_manifests.add(manifest)
                    found.manifests.append(
                        {
                            'path': manifest.relative_to(root).as_posix(),
                            'content': manifest.read_text(),
                        }
                    )
                break
            if directory == root:
                break
    if len(paths) > MAX_FILES:
        found.skipped.append(f'only the first {MAX_FILES} files were read')
    return found
