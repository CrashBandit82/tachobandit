// tachobandit – stores tachograph files (.ddd) and serves them decoded as JSON
// together with a small web UI. Decoding and signature verification come from
// tachoparser (github.com/traconiq/tachoparser); this file is built inside that
// source tree (see Dockerfile), so it can register the embedded certificates.
// tachoparser's go.mod targets Go 1.19; enable the Go 1.22 router patterns.
//go:debug httpmuxgo121=0

package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "github.com/traconiq/tachoparser/internal/pkg/certificates"
	"github.com/traconiq/tachoparser/pkg/decoder"
)

//go:embed static
var static embed.FS

const maxUpload = 32 << 20

var (
	dataDir   = env("DATA_DIR", "/data")
	listen    = env("LISTEN", ":8080")
	idPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)
	unsafeChr = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type fileInfo struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Kind     string    `json:"kind"`
	Size     int64     `json:"size"`
	Uploaded time.Time `json:"uploaded"`
}

// Stored files are named "<id>__<original name>", id = first 16 hex chars of sha256.
func storedName(id, name string) string { return id + "__" + name }

func findFile(id string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", errors.New("ungültige ID")
	}
	m, _ := filepath.Glob(filepath.Join(dataDir, id+"__*"))
	if len(m) == 0 {
		return "", fs.ErrNotExist
	}
	return m[0], nil
}

// VU downloads start with the TREP tag 0x76; driver card files are TLV starting with 0x00.
func kindOf(data []byte) string {
	if len(data) > 0 && data[0] == 0x76 {
		return "vu"
	}
	return "card"
}

func decode(data []byte) (any, error) {
	if kindOf(data) == "vu" {
		var v decoder.Vu
		if _, err := decoder.UnmarshalTV(data, &v); err != nil {
			return nil, err
		}
		return v, nil
	}
	var c decoder.Card
	if _, err := decoder.UnmarshalTLV(data, &c); err != nil {
		return nil, err
	}
	// the TLV decoder skips unknown bytes, so arbitrary files "decode" to an empty card
	if strings.Trim(string(c.CardIdentificationAndDriverCardHolderIdentificationFirstGen.CardIdentification.CardNumber[:]), " \x00") == "" &&
		strings.Trim(string(c.CardIdentificationAndDriverCardHolderIdentificationSecondGen.CardIdentification.CardNumber[:]), " \x00") == "" {
		return nil, errors.New("keine Kartenidentifikation gefunden")
	}
	return c, nil
}

// strip drops signatures, certificates and per-second speed data – large and not shown in the UI.
func strip(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if strings.HasSuffix(k, "_sig") || strings.Contains(k, "certificate") ||
				strings.HasPrefix(k, "signature") || strings.HasPrefix(k, "vu_detailed_speed") ||
				k == "activity_daily_records" || k == "vu_configuration" {
				delete(t, k)
				continue
			}
			t[k] = strip(val)
		}
	case []any:
		for i := range t {
			t[i] = strip(t[i])
		}
	}
	return v
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func listFiles(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	files := []fileInfo{}
	for _, e := range entries {
		id, name, ok := strings.Cut(e.Name(), "__")
		if !ok || !idPattern.MatchString(id) || e.IsDir() {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		f, err := os.Open(filepath.Join(dataDir, e.Name()))
		if err != nil {
			continue
		}
		head := make([]byte, 1)
		f.Read(head)
		f.Close()
		files = append(files, fileInfo{id, name, kindOf(head), st.Size(), st.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Uploaded.After(files[j].Uploaded) })
	writeJSON(w, 200, files)
}

// store saves a decoded tachograph file under its content id (duplicates are kept once).
func store(filename string, data []byte) (*fileInfo, error) {
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:])[:16]
	name := unsafeChr.ReplaceAllString(filepath.Base(filename), "_")
	path := filepath.Join(dataDir, storedName(id, name))
	if old, err := findFile(id); err == nil {
		path = old // same content already stored
	} else if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	_, stored, _ := strings.Cut(filepath.Base(path), "__")
	return &fileInfo{id, stored, kindOf(data), st.Size(), st.ModTime()}, nil
}

func upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxUpload); err != nil {
		fail(w, 400, "Upload fehlerhaft: "+err.Error())
		return
	}
	type result struct {
		Name  string    `json:"name"`
		File  *fileInfo `json:"file,omitempty"`
		Error string    `json:"error,omitempty"`
	}
	results := []result{}
	for _, fh := range r.MultipartForm.File["files"] {
		res := result{Name: fh.Filename}
		data, err := func() ([]byte, error) {
			f, err := fh.Open()
			if err != nil {
				return nil, err
			}
			defer f.Close()
			return io.ReadAll(io.LimitReader(f, maxUpload))
		}()
		if err == nil {
			_, err = decode(data)
		}
		if err != nil {
			res.Error = "keine lesbare Tachografen-Datei: " + err.Error()
			results = append(results, res)
			continue
		}
		if res.File, err = store(fh.Filename, data); err != nil {
			res.Error = err.Error()
		}
		results = append(results, res)
	}
	writeJSON(w, 200, results)
}

func getFile(w http.ResponseWriter, r *http.Request) {
	path, err := findFile(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "Datei nicht gefunden")
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	if r.URL.Query().Has("raw") {
		_, name, _ := strings.Cut(filepath.Base(path), "__")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
		return
	}
	parsed, err := decode(data)
	if err != nil {
		fail(w, 422, "Datei nicht lesbar: "+err.Error())
		return
	}
	buf, _ := json.Marshal(parsed)
	var generic any
	json.Unmarshal(buf, &generic)
	writeJSON(w, 200, map[string]any{"kind": kindOf(data), "data": strip(generic)})
}

func deleteFile(w http.ResponseWriter, r *http.Request) {
	path, err := findFile(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "Datei nicht gefunden")
		return
	}
	if err := os.Remove(path); err != nil {
		fail(w, 500, err.Error())
		return
	}
	w.WriteHeader(204)
}

func main() {
	log.Printf("Zertifikate geladen: Gen1 %d, Gen2 %d", len(decoder.PKsFirstGen), len(decoder.PKsSecondGen))
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	staticFS, _ := fs.Sub(static, "static")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(staticFS))
	mux.HandleFunc("GET /api/files", listFiles)
	mux.HandleFunc("POST /api/files", upload)
	mux.HandleFunc("GET /api/files/{id}", getFile)
	mux.HandleFunc("DELETE /api/files/{id}", deleteFile)
	mux.HandleFunc("POST /api/card/read", readCardHandler)
	log.Printf("tachobandit auf %s, Daten in %s", listen, dataDir)
	log.Fatal(http.ListenAndServe(listen, mux))
}
