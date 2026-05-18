package api

import (
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/codeci/codeci/server/auth"
	dbpkg "github.com/codeci/codeci/server/db"
)

// GET /api/me/favorites — return the caller's favorited pipeline IDs, sorted.
func (h *Handler) ListMyFavorites(c echo.Context) error {
	claims := auth.GetClaims(c)
	var favs []dbpkg.UserFavorite
	h.db.Where("user_id = ?", claims.UserID).Order("pipeline_id asc").Find(&favs)
	out := make([]string, len(favs))
	for i, f := range favs {
		out[i] = f.PipelineID
	}
	return c.JSON(http.StatusOK, out)
}

// POST /api/me/favorites/:pipelineId — pin a pipeline to the caller's favorites.
// Idempotent: re-favoriting an already-favorited pipeline is a no-op.
func (h *Handler) AddMyFavorite(c echo.Context) error {
	claims := auth.GetClaims(c)
	id := c.Param("pipelineId")
	if id == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "pipeline id required")
	}
	// Verify the pipeline exists so we don't accumulate dangling rows.
	if _, err := h.loader.Get(id); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "pipeline not found")
	}
	fav := dbpkg.UserFavorite{UserID: claims.UserID, PipelineID: id}
	h.db.Where(dbpkg.UserFavorite{UserID: claims.UserID, PipelineID: id}).FirstOrCreate(&fav)
	return c.NoContent(http.StatusNoContent)
}

// DELETE /api/me/favorites/:pipelineId — unpin. Idempotent.
func (h *Handler) RemoveMyFavorite(c echo.Context) error {
	claims := auth.GetClaims(c)
	id := c.Param("pipelineId")
	if id == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "pipeline id required")
	}
	h.db.Where("user_id = ? AND pipeline_id = ?", claims.UserID, id).Delete(&dbpkg.UserFavorite{})
	return c.NoContent(http.StatusNoContent)
}
