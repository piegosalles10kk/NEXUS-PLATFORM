// Package fs provides safe file-system operations scoped to a project's
// persistent clone directory.  All paths are validated to prevent traversal
// attacks before any OS operation is performed.
package fs

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ProjectsBaseDir is the root under which each project's repo is cloned.
const ProjectsBaseDir = "./projects"

// FileEntry represents a single file or directory within a project.
type FileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`  // relative to project root
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// safeAbs resolves relPath inside the project's base directory and returns the
// absolute OS path. If imageName is "host", relPath is treated as an absolute
// or CWD-relative path on the host system. Returns an error if the resolved
// path would escape the project root (when not in "host" mode).
func safeAbs(imageName, relPath string) (string, error) {
	if imageName == "host" {
		if filepath.IsAbs(relPath) {
			return filepath.Clean(relPath), nil
		}
		return filepath.Abs(relPath)
	}

	var base string
	if imageName == "" || imageName == "." || imageName == "/" {
		base = ProjectsBaseDir
	} else {
		// Sanitise imageName — strip any path separators so it stays a single dir.
		clean := filepath.Base(filepath.Clean(imageName))
		if clean == "." || clean == ".." || clean == "" {
			return "", fmt.Errorf("invalid imageName")
		}
		base = filepath.Join(ProjectsBaseDir, clean)
	}

	// filepath.Join already cleans the path; Join(base, "") == base.
	target := filepath.Join(base, relPath)

	// Verify the target is still under base.
	rel, err := filepath.Rel(base, target)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path escapes project directory")
	}

	return target, nil
}

// ListFiles returns the immediate children of relPath inside the project
// directory.  The special ".git" directory is always excluded.
func ListFiles(imageName, relPath string) ([]FileEntry, error) {
	abs, err := safeAbs(imageName, relPath)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, fmt.Errorf("listFiles: %w", err)
	}

	result := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		if imageName != "host" && e.Name() == ".git" {
			continue
		}

		var size int64
		if !e.IsDir() {
			if info, infoErr := e.Info(); infoErr == nil {
				size = info.Size()
			}
		}

		// Build a clean relative path to the child.
		childRel := e.Name()
		if relPath != "" && relPath != "/" && relPath != "." {
			childRel = filepath.Join(relPath, e.Name())
		}

		result = append(result, FileEntry{
			Name:  e.Name(),
			Path:  childRel,
			IsDir: e.IsDir(),
			Size:  size,
		})
	}
	return result, nil
}

// ReadFile returns the text content of the file at relPath.
// Returns an error if the file is larger than 1 MB to protect the WebSocket channel.
func ReadFile(imageName, relPath string) (string, error) {
	abs, err := safeAbs(imageName, relPath)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("readFile stat: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory")
	}
	const maxBytes = 10 * 1024 * 1024 // 10 MB
	if info.Size() > maxBytes {
		return "", fmt.Errorf("file too large (%d bytes; limit %d)", info.Size(), maxBytes)
	}

	b, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("readFile: %w", err)
	}
	return string(b), nil
}

// WriteFile writes content to the file at relPath, creating it if it does not
// exist.  Parent directories are created as needed.
func WriteFile(imageName, relPath, content string) error {
	abs, err := safeAbs(imageName, relPath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return fmt.Errorf("writeFile mkdir: %w", err)
	}

	return os.WriteFile(abs, []byte(content), 0644)
}

// DeleteFile removes the file or directory at relPath (recursive).
func DeleteFile(imageName, relPath string) error {
	abs, err := safeAbs(imageName, relPath)
	if err != nil {
		return err
	}
	return os.RemoveAll(abs)
}

// CopyFile duplicates the file or directory at srcRel to dstRel (recursive).
func CopyFile(imageName, srcRel, dstRel string) error {
	src, err := safeAbs(imageName, srcRel)
	if err != nil {
		return err
	}
	dst, err := safeAbs(imageName, dstRel)
	if err != nil {
		return err
	}

	info, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("copy source stat: %w", err)
	}

	if info.IsDir() {
		return copyDir(src, dst)
	}
	return copyFile(src, dst)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

func copyDir(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dst, info.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcChild := filepath.Join(src, entry.Name())
		dstChild := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcChild, dstChild); err != nil {
				return err
			}
		} else {
			if err := copyFile(srcChild, dstChild); err != nil {
				return err
			}
		}
	}
	return nil
}

// MoveFile moves the file or directory at srcRel to dstRel (recursive).
func MoveFile(imageName, srcRel, dstRel string) error {
	src, err := safeAbs(imageName, srcRel)
	if err != nil {
		return err
	}
	dst, err := safeAbs(imageName, dstRel)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	return os.Rename(src, dst)
}

// ReadFileB64 returns the base64-encoded content of the file at relPath.
func ReadFileB64(imageName, relPath string) (string, error) {
	abs, err := safeAbs(imageName, relPath)
	if err != nil {
		return "", err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("readFile stat: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory")
	}
	const maxBytes = 10 * 1024 * 1024 // 10 MB
	if info.Size() > maxBytes {
		return "", fmt.Errorf("file too large (%d bytes; limit %d)", info.Size(), maxBytes)
	}

	b, err := os.ReadFile(abs)
	if err != nil {
		return "", fmt.Errorf("readFile: %w", err)
	}
	return base64.StdEncoding.EncodeToString(b), nil
}

// WriteFileB64 writes base64-decoded content to the file at relPath.
func WriteFileB64(imageName, relPath, contentB64 string) error {
	abs, err := safeAbs(imageName, relPath)
	if err != nil {
		return err
	}

	data, err := base64.StdEncoding.DecodeString(contentB64)
	if err != nil {
		return fmt.Errorf("invalid base64: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return fmt.Errorf("writeFile mkdir: %w", err)
	}

	return os.WriteFile(abs, data, 0644)
}
