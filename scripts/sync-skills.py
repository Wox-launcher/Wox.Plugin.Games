import os
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = "https://github.com/Wox-launcher/Wox.git"
SKILLS = (
    ".agents/skills/wox-plugin-creator",
    ".agents/skills/wox-plugin-submit2store",
)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="wox-skills-") as checkout:
        subprocess.run(
            ["git", "clone", "--depth=1", "--filter=blob:none", "--sparse", UPSTREAM, checkout],
            check=True,
        )
        subprocess.run(["git", "sparse-checkout", "set", *SKILLS], cwd=checkout, check=True)
        for skill in SKILLS:
            if not Path(checkout, skill, "SKILL.md").is_file():
                raise SystemExit(f"Skill missing from Wox upstream: {skill}")

        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=checkout, text=True,
        ).strip()
        # Compare the two trees without adding upstream objects to this repository.
        env = {**os.environ, "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(Path(checkout, ".git", "objects"))}
        patch = subprocess.check_output(
            [
                "git", "diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv",
                "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", commit, "--", *SKILLS,
            ],
            cwd=ROOT,
            env=env,
        )

    apply = ["git", "apply", "--whitespace=nowarn"]
    if not patch or subprocess.run(
        [*apply, "--reverse", "--check"], cwd=ROOT, input=patch, stderr=subprocess.DEVNULL,
    ).returncode == 0:
        print("Skills are up to date.")
        return

    subprocess.run(apply, cwd=ROOT, input=patch, check=True)
    print(f"Synced skills from Wox {commit[:12]}.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
