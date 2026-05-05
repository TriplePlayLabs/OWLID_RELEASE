use thiserror::Error;

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("Database error: {0}")]
    SqlxError(#[from] sqlx::Error),

    #[error("Entity not found: {0}")]
    NotFound(String),

    #[error("Duplicate entry: {0}")]
    Duplicate(String),

    #[error("Invalid data: {0}")]
    InvalidData(String),

    #[error("Authorization error: {0}")]
    Unauthorized(String),
}

pub type Result<T> = std::result::Result<T, DatabaseError>;
