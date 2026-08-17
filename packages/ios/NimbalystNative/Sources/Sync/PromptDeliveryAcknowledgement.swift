import Foundation

/// Monotonic acknowledgement state for one mobile prompt submission.
///
/// A sync snapshot may arrive out of order, so once the desktop has confirmed
/// this prompt in its durable queue, an older empty snapshot must not make the
/// compose UI look idle again. Execution is only inferred for submissions that
/// began while the session was idle; an already-running session may be working
/// on an earlier prompt while this one is merely queued.
public enum PromptDeliveryAcknowledgementState: Equatable {
    case idle
    case confirming(id: String, sessionWasExecuting: Bool)
    case queued(id: String, sessionWasExecuting: Bool)
    case executing(id: String)

    public var submissionId: String? {
        switch self {
        case .idle:
            nil
        case let .confirming(id, _), let .queued(id, _), let .executing(id):
            id
        }
    }

    public var isAcknowledged: Bool {
        switch self {
        case .queued, .executing:
            true
        case .idle, .confirming:
            false
        }
    }

    public var composeStatus: PromptDeliveryComposeStatus {
        switch self {
        case .confirming:
            .confirming
        case .queued:
            .queued
        case .idle, .executing:
            .idle
        }
    }
}

public enum PromptDeliveryComposeStatus: Equatable {
    case idle
    case confirming
    case queued
}

public enum PromptDeliveryAcknowledgementEvent: Equatable {
    case submitted(id: String, sessionWasExecuting: Bool)
    case observedQueuedPromptIds([String])
    case observedExecution(Bool)
    case reset
}

/// Reduces acknowledgement observations without allowing stale state to erase
/// a successful acknowledgement for the active submission.
public func reducePromptDeliveryAcknowledgement(
    _ state: PromptDeliveryAcknowledgementState,
    event: PromptDeliveryAcknowledgementEvent
) -> PromptDeliveryAcknowledgementState {
    switch event {
    case let .submitted(id, sessionWasExecuting):
        .confirming(id: id, sessionWasExecuting: sessionWasExecuting)

    case .reset:
        .idle

    case let .observedQueuedPromptIds(ids):
        guard let submissionId = state.submissionId, ids.contains(submissionId) else {
            return state
        }
        switch state {
        case let .confirming(id, sessionWasExecuting):
            .queued(id: id, sessionWasExecuting: sessionWasExecuting)
        case .idle, .queued, .executing:
            state
        }

    case let .observedExecution(isExecuting):
        guard isExecuting else { return state }
        switch state {
        case let .confirming(id, sessionWasExecuting) where !sessionWasExecuting:
            .executing(id: id)
        case let .queued(id, sessionWasExecuting) where !sessionWasExecuting:
            .executing(id: id)
        case .idle, .confirming, .queued, .executing:
            state
        }
    }
}
